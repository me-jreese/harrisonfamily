"""Media files down (sync.md 8.3 step 6, section 9): presigned GET, verify sha256 and md5, write to `media_root/<handle><ext>`.

Done before the backup so the one local transaction can set `Media.path`. A file that is already there with the right sha256 is not
downloaded again, which also makes a run after a crash between the download and the sidecar update cost one API call per file. A
failed download defers only that Media object (and what refers to it) to the next run. A Media with no cloud blob (`404 no_blob`:
a held or placeholder file) still syncs its metadata; it just has no local path.

The verified bytes are checked once more before anything is written (BRD2 D2-06: the desktop re-checks GPS on download): a JPEG, PNG or
TIFF that carries an EXIF GPS position, or an empty file, is HELD. `download` then returns ``{"held": <rule>}``, nothing is written, and
the Media object syncs without a local path; the pull records a hold with guidance. The Media's own metadata is not lost, and a good
local file is never replaced by a held one.
"""
import hashlib
import os
import re
import tempfile
import urllib.parse

from . import consts, mediafile, transport
from .backup import sha256_file

_HANDLE = re.compile(consts.HANDLE_PATTERN)
EXTENSIONS = mediafile.EXTENSIONS


def safe_path(media_root, handle, ext):
    """`media_root/<handle><ext>` for a plain handle that stays under `media_root`; ValueError for anything else (a hostile handle)."""
    if not isinstance(handle, str) or not _HANDLE.match(handle):
        raise ValueError("the media handle is not a plain handle")
    path = os.path.join(media_root, handle + ext)
    root = os.path.realpath(media_root)
    real = os.path.realpath(path)
    if os.path.dirname(real) != root or os.path.basename(real) != handle + ext:  # also a symlink planted at the target stays inside
        raise ValueError("the media path would leave the media folder")
    return path


def check_download_url(url):
    """A presigned URL is https (plain http only to a loopback host: the dev server) and carries no userinfo."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" and not (parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost", "::1")):
        raise transport.TransportError("bad_download_url", consts.EXIT_INTERNAL, message="The download URL is not an https URL.")
    if parts.username or parts.password or not parts.hostname:
        raise transport.TransportError("bad_download_url", consts.EXIT_INTERNAL, message="The download URL is not usable.")
    return url


def fetch_verified(fetch, request_url, expect_sha256=None):
    """`fetch(url)` the bytes of the URL that `request_url()` returns; one fresh request when the first URL was refused (D52)."""
    last = None
    for attempt in (0, 1):
        info = request_url()
        try:
            return info, fetch(check_download_url(info["url"]))
        except transport.TransportError as exc:
            last = exc
            if exc.status != 403:
                raise
    raise last


def _write_atomic(path, data):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".dl.", dir=directory)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def download(cloud, handle, media_root):
    """Downloads one Media file. Returns {"path", "sha256", "md5", "size", "fresh"}, {"held": rule, ...} (see above) or None for a Media
    with no blob.

    Raises transport.TransportError for anything else (the caller defers the object) and ValueError when the bytes do not match the
    checksums the website announced (nothing is written).
    """
    if not isinstance(handle, str) or not _HANDLE.match(handle):
        raise ValueError("the media handle is not a plain handle")
    try:
        info = cloud.media_download(handle)
    except transport.TransportError as exc:
        if exc.status == 404 and exc.code == "no_blob":
            return None
        raise
    ext = EXTENSIONS.get(info.get("content_type"))
    if not ext or not isinstance(info.get("sha256"), str):
        raise ValueError("the website announced a file type the addon does not accept")
    path = safe_path(media_root, handle, ext)
    if os.path.isfile(path) and sha256_file(path) == info["sha256"]:
        return {"path": path, "sha256": info["sha256"], "md5": info.get("md5", ""), "size": os.path.getsize(path), "fresh": False}
    holder = {"info": info}

    def request_url():
        if "again" in holder:
            holder["info"] = cloud.media_download(handle)
        holder["again"] = True
        return holder["info"]

    info, data = fetch_verified(cloud.fetch, request_url)
    if hashlib.sha256(data).hexdigest() != info["sha256"] or (info.get("md5") and hashlib.md5(data).hexdigest() != info["md5"]) \
            or (isinstance(info.get("size"), int) and len(data) != info["size"]):
        raise ValueError("the downloaded file does not match the checksums the website announced")
    rule = mediafile.hold_for_bytes(data)
    if rule:
        return {"held": rule, "sha256": info["sha256"], "md5": info.get("md5", ""), "size": len(data), "fresh": False}
    _write_atomic(path, data)
    return {"path": path, "sha256": info["sha256"], "md5": info.get("md5", ""), "size": len(data), "fresh": True}
