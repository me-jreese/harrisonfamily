"""boto3 adapters for the ports the engine uses. The only module that imports boto3 (the engine and its tests never do).

Ports (duck-typed; ``tests/unit/render_lambda_support.py`` has in-memory fakes with the same methods):

Table
    get(pk, sk, consistent=True) -> dict | None
    query_log(lo_seq, hi_seq) -> iterator of SYNC#LOG items, ascending, strongly consistent
    batch_get(keys) -> {(pk, sk): item}                      strongly consistent
    query_heads(cls) -> iterator of REC# head items          GSI1 RECS#<cls>, eventually consistent (reconcile only)
    read_state() -> dict | None                              SYNC#RENDER / STATE
    write_state(fields, remove=()) -> None                   unconditional SET / REMOVE on the state item
    commit_pass(expect, fields, remove, outbox) -> None      state update (conditional on the cursor read) + outbox put, one transaction

Bucket
    get(key) -> bytes | None;  put(key, body, sha256_hex);  delete(key);  head_sha256(key) -> hex | None;  list_keys(prefix) -> iterator

Metrics
    emit(name, value=1)
"""

from __future__ import annotations

import base64
import binascii
import json
from decimal import Decimal
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from . import errors

STATE_KEY = ("SYNC#RENDER", "STATE")
LOG_PK = "SYNC#LOG"
HEAD_PK = "SYNC#HEAD"


def seq_key(seq: int) -> str:
    return str(int(seq)).zfill(12)


def _plain(value: Any) -> Any:
    """DynamoDB Decimals back to int (the store holds integers only) or float."""

    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return sorted(_plain(v) for v in value)
    return value


class DynamoTable:
    def __init__(self, client: Any, table_name: str) -> None:
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

        self._c = client
        self._t = table_name
        self._ser = TypeSerializer()
        self._de = TypeDeserializer()

    # -- encoding ----------------------------------------------------------------------------------------------------
    def _enc(self, item: Dict[str, Any]) -> Dict[str, Any]:
        return {k: self._ser.serialize(v) for k, v in item.items()}

    def _dec(self, item: Dict[str, Any]) -> Dict[str, Any]:
        return {k: _plain(self._de.deserialize(v)) for k, v in item.items()}

    # -- reads -------------------------------------------------------------------------------------------------------
    def get(self, pk: str, sk: str, consistent: bool = True) -> Optional[Dict[str, Any]]:
        res = self._c.get_item(TableName=self._t, Key=self._enc({"PK": pk, "SK": sk}), ConsistentRead=consistent)
        item = res.get("Item")
        return self._dec(item) if item else None

    def query_log(self, lo_seq: int, hi_seq: int) -> Iterator[Dict[str, Any]]:
        start: Optional[Dict[str, Any]] = None
        while True:
            args: Dict[str, Any] = dict(
                TableName=self._t, ConsistentRead=True,
                KeyConditionExpression="PK = :pk AND SK BETWEEN :lo AND :hi",
                ExpressionAttributeValues=self._enc({":pk": LOG_PK, ":lo": seq_key(lo_seq), ":hi": seq_key(hi_seq)}),
            )
            if start:
                args["ExclusiveStartKey"] = start
            res = self._c.query(**args)
            for item in res.get("Items", []):
                yield self._dec(item)
            start = res.get("LastEvaluatedKey")
            if not start:
                return

    def batch_get(self, keys: Iterable[Tuple[str, str]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
        wanted = list(dict.fromkeys(keys))
        out: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for i in range(0, len(wanted), 100):
            request = {self._t: {"Keys": [self._enc({"PK": pk, "SK": sk}) for pk, sk in wanted[i:i + 100]], "ConsistentRead": True}}
            for _attempt in range(8):
                res = self._c.batch_get_item(RequestItems=request)
                for raw in res.get("Responses", {}).get(self._t, []):
                    item = self._dec(raw)
                    out[(item["PK"], item["SK"])] = item
                request = res.get("UnprocessedKeys") or {}
                if not request:
                    break
            else:
                raise errors.RenderFailed("view.batch_get_unprocessed")
        return out

    def query_heads(self, cls: str) -> Iterator[Dict[str, Any]]:
        start: Optional[Dict[str, Any]] = None
        while True:
            args: Dict[str, Any] = dict(
                TableName=self._t, IndexName="GSI1", KeyConditionExpression="GSI1PK = :pk",
                ExpressionAttributeValues=self._enc({":pk": f"RECS#{cls}"}),
            )
            if start:
                args["ExclusiveStartKey"] = start
            res = self._c.query(**args)
            for item in res.get("Items", []):
                yield self._dec(item)
            start = res.get("LastEvaluatedKey")
            if not start:
                return

    def read_state(self) -> Optional[Dict[str, Any]]:
        return self.get(*STATE_KEY, consistent=True)

    # -- writes (only SYNC#RENDER and SYNC#RENDERED: the role's LeadingKeys condition) ---------------------------------------
    def _update_args(self, fields: Dict[str, Any], remove: Iterable[str]) -> Dict[str, Any]:
        names: Dict[str, str] = {}
        values: Dict[str, Any] = {}
        sets: List[str] = []
        for i, (k, v) in enumerate(sorted(fields.items())):
            names[f"#f{i}"] = k
            values[f":v{i}"] = v
            sets.append(f"#f{i} = :v{i}")
        removes: List[str] = []
        for j, k in enumerate(sorted(remove)):
            names[f"#r{j}"] = k
            removes.append(f"#r{j}")
        expr = ("SET " + ", ".join(sets) if sets else "") + (" REMOVE " + ", ".join(removes) if removes else "")
        args: Dict[str, Any] = dict(UpdateExpression=expr.strip(), ExpressionAttributeNames=names)
        if values:
            args["ExpressionAttributeValues"] = self._enc(values)
        return args

    def write_state(self, fields: Dict[str, Any], remove: Iterable[str] = ()) -> None:
        self._c.update_item(TableName=self._t, Key=self._enc({"PK": STATE_KEY[0], "SK": STATE_KEY[1]}), **self._update_args(fields, remove))

    def commit_pass(self, expect: Optional[int], fields: Dict[str, Any], remove: Iterable[str], outbox: Optional[Dict[str, Any]]) -> None:
        """Advance the cursor and write the outbox item in one transaction, so a retried pass can never notify twice.

        ``expect`` is the ``rendered_seq`` the pass read (None when the state item had none): the update fails if another writer moved it."""

        args = self._update_args(fields, remove)
        if expect is None:
            condition: Dict[str, Any] = {"ConditionExpression": "attribute_not_exists(rendered_seq)"}
        else:
            args["ExpressionAttributeValues"] = {**args.get("ExpressionAttributeValues", {}), **self._enc({":expect": expect})}
            condition = {"ConditionExpression": "rendered_seq = :expect"}
        update = {"TableName": self._t, "Key": self._enc({"PK": STATE_KEY[0], "SK": STATE_KEY[1]}), **args, **condition}
        items: List[Dict[str, Any]] = [{"Update": update}]
        if outbox is not None:
            items.append({"Put": {"TableName": self._t, "Item": self._enc(outbox)}})
        try:
            self._c.transact_write_items(TransactItems=items)
        except self._c.exceptions.TransactionCanceledException:
            raise errors.RenderFailed(errors.RULE_STATE_CONFLICT) from None


class S3Bucket:
    """A bucket (or a prefix of one: ``prefix`` is added to every key, so shadow mode is ``S3Bucket(client, sync_bucket, 'render-shadow/')``)."""

    def __init__(self, client: Any, bucket: str, prefix: str = "") -> None:
        self._c = client
        self._b = bucket
        self._p = prefix

    @staticmethod
    def _missing(exc: Exception) -> bool:
        code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        return code in ("NoSuchKey", "404", "NotFound")

    def get(self, key: str) -> Optional[bytes]:
        try:
            return self._c.get_object(Bucket=self._b, Key=self._p + key)["Body"].read()
        except Exception as exc:  # botocore ClientError; matched by code so this module needs no botocore import
            if self._missing(exc):
                return None
            raise

    def put(self, key: str, body: bytes, sha256_hex: str) -> None:
        checksum = base64.b64encode(binascii.unhexlify(sha256_hex)).decode("ascii")
        self._c.put_object(
            Bucket=self._b, Key=self._p + key, Body=body, ContentType="application/json", ChecksumSHA256=checksum,
        )

    def delete(self, key: str) -> None:
        self._c.delete_object(Bucket=self._b, Key=self._p + key)

    def head_sha256(self, key: str) -> Optional[str]:
        try:
            res = self._c.head_object(Bucket=self._b, Key=self._p + key, ChecksumMode="ENABLED")
        except Exception as exc:
            if self._missing(exc):
                return None
            raise
        b64 = res.get("ChecksumSHA256")
        return binascii.hexlify(base64.b64decode(b64)).decode("ascii") if b64 else ""

    def list_keys(self, prefix: str) -> Iterator[str]:
        token: Optional[str] = None
        while True:
            args: Dict[str, Any] = dict(Bucket=self._b, Prefix=self._p + prefix)
            if token:
                args["ContinuationToken"] = token
            res = self._c.list_objects_v2(**args)
            for obj in res.get("Contents", []):
                yield obj["Key"][len(self._p):]
            if not res.get("IsTruncated"):
                return
            token = res.get("NextContinuationToken")


class CloudWatchMetrics:
    """``emit(name, value)`` puts one data point; a failed put is swallowed (a metric must never fail a pass)."""

    def __init__(self, client: Any, namespace: str, log: Any = None) -> None:
        self._c = client
        self._ns = namespace
        self._log = log

    def emit(self, name: str, value: float = 1) -> None:
        try:
            self._c.put_metric_data(Namespace=self._ns, MetricData=[{"MetricName": name, "Value": value, "Unit": "Count"}])
        except Exception as exc:
            if self._log is not None:
                self._log.warning("metric %s not emitted: %s", name, errors.describe(exc)[0])


class LambdaInvoker:
    """``invoke(payload)`` starts another function asynchronously (``InvocationType=Event``): the call returns when Lambda has queued the event,
    not when the function has run. Used for hfy-graph-render after a live pass; a failure raises, and the caller decides what it costs."""

    def __init__(self, client: Any, function_name: str) -> None:
        self._c = client
        self._f = function_name

    def invoke(self, payload: Dict[str, Any]) -> None:
        self._c.invoke(FunctionName=self._f, InvocationType="Event", Payload=json.dumps(payload, sort_keys=True).encode("utf-8"))
