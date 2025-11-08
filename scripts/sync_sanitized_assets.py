#!/usr/bin/env python3
"""
Ensure every private asset in workspace-local has a sanitized counterpart in workspace/.

Usage:
  python scripts/sync_sanitized_assets.py --check   # report missing sanitized files
  python scripts/sync_sanitized_assets.py --sync    # create placeholder sanitised files where missing

The script never copies real data; it creates lightweight placeholder JSON/text files so the
workspace structure mirrors workspace-local without leaking secrets.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, List

PROJECT_ROOT = Path(__file__).resolve().parents[2]

CONFIG: List[Dict[str, str]] = [
    {
        "name": "allowlist",
        "private": "workspace-local/allowlist",
        "sanitized": "workspace/allowlist",
        "kind": "allowlist_json"
    },
    {
        "name": "cloudfront",
        "private": "workspace-local/cloudfront",
        "sanitized": "workspace/cloudfront",
        "kind": "generic_json"
    },
    {
        "name": "coming-soon",
        "private": "workspace-local/coming-soon-index.html",
        "sanitized": "workspace/coming-soon-index.html",
        "kind": "html"
    }
]


def iter_private_files(private_root: Path) -> List[Path]:
    if private_root.is_file():
        return [private_root]
    files: List[Path] = []
    if not private_root.exists():
        return files
    for path in private_root.rglob("*"):
        if path.is_file():
            files.append(path)
    return files


def placeholder_json(rel: str, data: Dict[str, str]) -> str:
    payload = {
        "placeholder": True,
        "source": rel,
        "instructions": data.get("instructions", "Replace with sanitized sample data.")
    }
    return json.dumps(payload, indent=2) + "\n"


def write_placeholder(dest: Path, rel: str, kind: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if kind == "allowlist_json":
        content = json.dumps(
            [
                "sample1@example.com",
                "sample2@example.com"
            ],
            indent=2
        ) + "\n"
    elif kind in ("generic_json",):
        content = placeholder_json(rel, {})
    elif kind == "html":
        content = "<!-- Placeholder copy for {} -->\n<p>Replace with sanitized HTML.</p>\n".format(rel)
    else:
        content = "Placeholder for {}\n".format(rel)
    dest.write_text(content, encoding="utf-8")


def process(sync: bool) -> int:
    missing_total = 0
    for entry in CONFIG:
        private_root = PROJECT_ROOT / entry["private"]
        sanitized_root = PROJECT_ROOT / entry["sanitized"]
        kind = entry["kind"]

        if not private_root.exists():
            continue

        files = iter_private_files(private_root)
        for file_path in files:
            rel = file_path.relative_to(private_root) if private_root.is_dir() else Path(file_path.name)
            dest = sanitized_root / rel
            if dest.exists():
                continue
            missing_total += 1
            print(f"[MISSING] {entry['name']}: {rel.as_posix()}")
            if sync:
                write_placeholder(dest, rel.as_posix(), kind)
                print(f"[SYNCED] Created sanitized placeholder at {dest}")
    return missing_total


def main() -> None:
    parser = argparse.ArgumentParser(description="Ensure sanitized workspace assets mirror workspace-local.")
    parser.add_argument("--sync", action="store_true", help="Create placeholder files where missing.")
    args = parser.parse_args()

    missing = process(sync=args.sync)
    if missing and not args.sync:
        print(f"[WARN] Found {missing} missing sanitized files. Re-run with --sync to create placeholders.")
    elif not missing:
        print("[OK] Sanitized workspace mirrors workspace-local for tracked assets.")


if __name__ == "__main__":
    main()
