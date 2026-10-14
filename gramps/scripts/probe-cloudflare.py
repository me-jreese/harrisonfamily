#!/usr/bin/env python3
"""Probe: is a urllib request from Gramps' bundled Python answered by the origin, or challenged by Cloudflare? (HFY-TSK-180, DL-31, R2-34)

    gramps/tests/gramps/gramps-shim.sh --script gramps/scripts/probe-cloudflare.py [--server https://host] [--token-file PATH] [--default-user-agent]

Sends one GET to <server>/api/sync/meta the way the addon does (verified TLS, the handshake headers and the addon's own
User-Agent; --default-user-agent sends urllib's `Python-urllib/x.y` instead, to show what Cloudflare does with it), with no token
or with the test token in --token-file, and prints one JSON line: the HTTP status, the error code and message of the JSON body,
whether a `cf-mitigated` header was present, whether the body is the house error format {error, message} (an origin answer) or
something else (a Cloudflare block such as `error code: 1010`, or a challenge page), how many
roots the default trust store held and whether the /etc/ssl/cert.pem fallback was needed. It prints no header values, no body
text beyond the error code and message of a JSON error, and never a token. Exit 0 when the answer came from the origin
(a house-format error or a success, no cf-mitigated header), 1 when it looks blocked or challenged, 2 on a network or TLS failure.
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from hfygramps.addon import consts, transport  # noqa: E402


def house_error(body):
    return isinstance(body, dict) and isinstance(body.get("error"), str) and isinstance(body.get("message"), str)


def main(argv):
    server = "https://harrisonfamily.us"
    token = None
    default_agent = False
    it = iter(argv)
    for tok in it:
        if tok == "--server":
            server = next(it)
        elif tok == "--token-file":
            with open(next(it), encoding="utf-8") as fh:
                token = fh.read().strip()
        elif tok == "--default-user-agent":
            default_agent = True
        else:
            print("usage: probe-cloudflare.py [--server URL] [--token-file PATH] [--default-user-agent]", file=sys.stderr)
            return 64
    server = transport.check_server(server)
    default_roots = ssl.create_default_context().cert_store_stats().get("x509_ca", 0)
    ctx = transport.make_ssl_context()
    headers = transport.Versions("6.0.6", consts.SUPPORTED_DB_SCHEMAS[0]).headers()
    headers["Accept"] = "application/json"
    headers["User-Agent"] = ("Python-urllib/%d.%d" % sys.version_info[:2]) if default_agent else transport.USER_AGENT
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(server + "/api/sync/meta", headers=headers, method="GET")
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
    out = {"python": sys.version.split()[0], "openssl": ssl.OPENSSL_VERSION, "default_store_roots": default_roots,
           "fallback_used": default_roots == 0, "verify_mode": "CERT_REQUIRED" if ctx.verify_mode == ssl.CERT_REQUIRED else "other",
           "token_sent": bool(token), "user_agent": "urllib-default" if default_agent else "hfy_sync"}
    try:
        try:
            resp = opener.open(req, timeout=30)
            status, hdrs, raw = resp.status, resp.headers, resp.read(65536)
        except urllib.error.HTTPError as exc:
            status, hdrs, raw = exc.code, exc.headers, exc.read(65536)
    except (urllib.error.URLError, OSError) as exc:
        out.update({"result": "network_or_tls_failure", "error_type": type(getattr(exc, "reason", exc)).__name__})
        print(json.dumps(out, sort_keys=True))
        return 2
    try:
        body = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        body = None
    mitigated = hdrs.get("cf-mitigated") is not None
    text = raw.decode("utf-8", "replace").strip() if body is None else ""
    if body is None and len(text) < 40 and text.startswith("error code: "):
        out["edge_block_text"] = text  # Cloudflare's own one-line block, for example `error code: 1010`
    out.update({"status": status, "cf_mitigated_header": mitigated, "cf_ray_present": hdrs.get("cf-ray") is not None,
                "content_type_json": "json" in (hdrs.get("content-type") or ""), "body_is_json": body is not None,
                "body_is_house_error": house_error(body)})
    if isinstance(body, dict):
        out["error_body"] = {k: body[k] for k in ("error", "message") if isinstance(body.get(k), str) and len(body[k]) < 200}
    house = house_error(body)
    origin = (house or (status < 300 and body is not None)) and not mitigated
    out["result"] = "answered_by_origin" if origin else "challenged_or_unexpected"
    print(json.dumps(out, sort_keys=True))
    return 0 if origin else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
