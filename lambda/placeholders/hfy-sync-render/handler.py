"""Placeholder hfy-sync-render package (HFY-TSK-247). Writes nothing and reads nothing: it exists so the app stack can create the
function, its stream mapping and its schedule before the real renderer ships. render-lambda replaces the package by changing the
RenderCodeKey parameter only. Any RENDER_MODE other than off is refused loudly so a premature flip cannot look like a working renderer."""
import os


def handler(event, context):
    mode = os.environ.get("RENDER_MODE", "off")
    if mode != "off":
        raise RuntimeError("placeholder renderer: RENDER_MODE must be off until the real package is deployed")
    return {"status": "noop", "mode": mode}
