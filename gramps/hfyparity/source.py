"""Where the two sides come from: a staged folder, or a read-only download of the shadow prefix (HFY-TSK-370).

``scan_dir`` lists a folder as ``{site key: Path}`` and reads nothing. ``fetch_s3`` downloads ``s3://<bucket>/render-shadow/`` with the
caller's own AWS profile into a folder, and only ever with ``aws s3 sync <s3 uri> <local folder>``: a download. It passes no
``--delete`` and no other verb, and ``assert_read_only`` refuses any command line that is not exactly that shape. What the
``aws`` command prints is never shown (it can name keys): a failure is reported as a code word by the caller.
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional

_S3_PREFIX = re.compile(r"^s3://([a-z0-9][a-z0-9.\-]{1,61}[a-z0-9])/((?:[^/\s]+/)*)render-shadow/?$")
#: The only options the download may carry.
_ALLOWED_OPTIONS = frozenset({"--only-show-errors"})


class ShadowUnreachable(Exception):
    """The shadow output could not be read. Carries no message: the aws output can name keys."""


def scan_dir(root: str) -> Dict[str, Path]:
    """Every regular file under ``root`` as ``{posix path relative to root: Path}``. Symlinks and Finder litter are skipped."""
    base_path = Path(root)
    found: Dict[str, Path] = {}
    for base, _dirs, names in os.walk(root, followlinks=False):
        for name in names:
            if name == ".DS_Store" or name.startswith("._"):
                continue
            path = Path(base) / name
            if path.is_symlink() or not path.is_file():
                continue
            found[path.relative_to(base_path).as_posix()] = path
    return found


def normalise_prefix(value: str) -> Optional[str]:
    """``s3://<bucket>/<prefix>/render-shadow/`` with a trailing slash, or None when ``value`` is not such a prefix."""
    if _S3_PREFIX.match(value) is None:
        return None
    return value if value.endswith("/") else value + "/"


def sync_command(prefix: str, dest: str) -> List[str]:
    return ["aws", "s3", "sync", prefix, dest, "--only-show-errors"]


def assert_read_only(argv: List[str]) -> None:
    """Refuse any command that is not a download of an s3 prefix into a local folder."""
    ok = (
        len(argv) >= 5
        and argv[:3] == ["aws", "s3", "sync"]
        and argv[3].startswith("s3://")
        and not argv[4].startswith("s3://")
        and all(arg in _ALLOWED_OPTIONS for arg in argv[5:])
    )
    if not ok:
        raise ShadowUnreachable()


def fetch_s3(prefix: str, dest: str, run: Callable = subprocess.run, timeout: int = 3600) -> None:
    """Download ``prefix`` into ``dest``. Raises ``ShadowUnreachable`` on any failure; shows nothing of the command's output."""
    argv = sync_command(prefix, dest)
    assert_read_only(argv)
    try:
        done = run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        raise ShadowUnreachable() from None
    if done.returncode != 0:
        raise ShadowUnreachable()


@contextlib.contextmanager
def temp_dir() -> Iterator[str]:
    """A fresh folder that is removed on the way out, on an error too."""
    path = tempfile.mkdtemp(prefix="hfy-parity-")
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)
