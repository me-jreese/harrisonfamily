import json
import logging
import os
from google.cloud import secretmanager
from flask import jsonify

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

SECRET_NAME = os.environ.get("HFY_ALLOWLIST_SECRET", "harrisonfamily-allowlist")
PROJECT_ID = os.environ.get("GCP_PROJECT")

client = secretmanager.SecretManagerServiceClient()

def _build_secret_path():
    if SECRET_NAME.startswith("projects/"):
        return SECRET_NAME
    if not PROJECT_ID:
        raise RuntimeError("GCP_PROJECT not set for Cloud Function")
    return f"projects/{PROJECT_ID}/secrets/{SECRET_NAME}/versions/latest"


def _read_allowlist():
    secret_name = _build_secret_path()
    logger.info("Accessing allowlist secret", {"secret": secret_name})
    response = client.access_secret_version(name=secret_name)
    payload = response.payload.data.decode("utf-8")
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        # Secret already stores a raw string array; expose without modification
        data = payload
    return data


def get_allowlist(request):
    try:
        allowlist = _read_allowlist()
        logger.info("Returning allowlist payload", {"entryCount": len(allowlist) if isinstance(allowlist, list) else "n/a"})
        return jsonify({"allowlist": allowlist})
    except Exception as exc:
        logger.exception("Failed to fetch allowlist")
        return jsonify({"error": "allowlist_unavailable"}), 500
