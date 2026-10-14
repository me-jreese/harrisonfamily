"""hfy-sync-render (HFY-TSK-176): the Lambda entry point.

Triggers: the table stream (filtered to ``SYNC#LOG``; only a wake-up, the ``SYNC#LOG`` cursor is the truth), the 15-minute EventBridge
schedule (``{"source": "schedule"}``) and an operator invoke (``{"allow_mass_delete": true}``, ``{"prune_foreign": true}``,
``{"force": true}``, ``{"reconcile": true}``). RENDER_MODE (``off`` | ``shadow`` | ``live``) comes from the stack parameter ``RenderMode``;
``off`` returns at once without a single AWS call. Settings: TABLE_NAME, SYNC_BUCKET, SITE_BUCKET, METRICS_NAMESPACE.

A stream batch always answers ``{"batchItemFailures": []}`` once the pass has run: a render failure is recorded and alarmed by the engine
and recovered by the schedule, so it is not a batch failure. A schedule or operator invoke still raises ``RenderFailed``.

Nothing here logs or returns an exception message (see hfy_render/errors.py).
"""

import logging
import os

log = logging.getLogger("hfy.render")
log.setLevel(logging.INFO)

_CLIENTS = {}


def _is_stream(event):
    records = event.get("Records") if isinstance(event, dict) else None
    return isinstance(records, list) and bool(records) and all(isinstance(r, dict) and r.get("eventSource") == "aws:dynamodb" for r in records)


def _clients():
    if not _CLIENTS:
        import boto3  # the Lambda runtime provides it; imported here so RENDER_MODE=off needs nothing

        _CLIENTS.update(ddb=boto3.client("dynamodb"), s3=boto3.client("s3"), cw=boto3.client("cloudwatch"))
    return _CLIENTS


def build_engine(context=None, environ=None):
    from hfy_render import aws, engine

    env = os.environ if environ is None else environ
    mode = env.get("RENDER_MODE", "off")
    clients = _clients()
    sync_bucket = env["SYNC_BUCKET"]
    deps = engine.Deps(
        table=aws.DynamoTable(clients["ddb"], env["TABLE_NAME"]),
        sync_root=aws.S3Bucket(clients["s3"], sync_bucket),
        live_bucket=aws.S3Bucket(clients["s3"], env["SITE_BUCKET"]),
        shadow_bucket=aws.S3Bucket(clients["s3"], sync_bucket, "render-shadow/"),
        metrics=aws.CloudWatchMetrics(clients["cw"], env.get("METRICS_NAMESPACE", "HFY/SyncRender"), log),
        mode=mode,
        remaining_ms=(context.get_remaining_time_in_millis if context is not None and hasattr(context, "get_remaining_time_in_millis") else (lambda: 10 ** 9)),
    )
    return engine.Engine(deps)


def handler(event, context):
    mode = os.environ.get("RENDER_MODE", "off")
    stream = _is_stream(event)
    if mode == "off":
        return {"batchItemFailures": []} if stream else {"status": "noop", "mode": "off"}
    if mode not in ("shadow", "live"):
        raise RuntimeError("RENDER_MODE must be off, shadow or live")
    if not stream:
        return build_engine(context).run(event)
    # The stream is only a wake-up: the SYNC#LOG cursor is the truth and the 15-minute schedule retries. A failed pass has already
    # recorded its rule id (SYNC#RENDER.last_error) and raised RenderError, so failing the batch would only make the event source mapping
    # replay the same records against the same fault and stall the shard. Anything that is not a RenderFailed (a missing setting, a
    # code fault) is still raised.
    from hfy_render import errors

    try:
        build_engine(context).run(event)
    except errors.RenderFailed as exc:
        log.error("render stream wake-up failed rule=%s", exc.rule)
    return {"batchItemFailures": []}
