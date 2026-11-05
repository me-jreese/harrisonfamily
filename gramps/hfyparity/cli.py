"""hfy-parity: the arguments, the counts-only report and the exit codes (HFY-TSK-370). Standard library only.

    hfy-parity --legacy <dir> --shadow <dir | s3://<bucket>/render-shadow/> [--json]

Exit codes:
    0   no difference at all (a difference that only the normalisation of generatedAt and index order hides does not count)
    10  differences exist and every one is explained by a rule
    20  at least one difference is unexplained
    64  usage error
    69  the shadow output is unreachable or holds none of the renderer's files
    70  an internal error (the exception class is printed, never its message)
    78  the legacy folder is missing or holds none of the files to compare

Nothing printed here, on stdout or stderr, names a key, an id, a name, a path or a value: the report holds counts, class and
rule ids, areas and schema field names, and every failure is a code word.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
from typing import Any, Callable, Dict, List, Optional, TextIO

from . import compare as compare_mod
from . import rules, source

EXIT_IDENTICAL, EXIT_EXPLAINED, EXIT_UNEXPLAINED = 0, 10, 20
EXIT_USAGE, EXIT_SHADOW, EXIT_INTERNAL, EXIT_LEGACY = 64, 69, 70, 78
_VERDICT_EXIT = {"identical": EXIT_IDENTICAL, "explained": EXIT_EXPLAINED, "unexplained": EXIT_UNEXPLAINED}


class _Parser(argparse.ArgumentParser):
    """argparse echoes the offending argument in its errors; this one prints a code word."""

    def __init__(self, *args: Any, err: TextIO, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self._err = err

    def error(self, message: str) -> None:  # type: ignore[override]
        self.print_usage(self._err)
        self._err.write("hfy-parity: usage_error\n")
        raise SystemExit(EXIT_USAGE)


def _parser(err: TextIO) -> _Parser:
    parser = _Parser(prog="hfy-parity", allow_abbrev=False, err=err, description=(
        "Counts-only parity report: the shadow render against a legacy export staged at the same moment."))
    parser.add_argument("--legacy", required=True, metavar="DIR", help="the staged legacy export (person/, event/, ... at its top)")
    parser.add_argument("--shadow", required=True, metavar="DIR_OR_S3_PREFIX",
                        help="a local folder, or s3://<bucket>/render-shadow/ (downloaded read-only with your own AWS profile)")
    parser.add_argument("--json", action="store_true", help="print the counts as JSON")
    return parser


def _pairs(counts: Dict[str, int]) -> str:
    return ", ".join("%s %d" % (name, n) for name, n in counts.items())


def format_report(result: Dict[str, Any], exit_code: int) -> str:
    files, classes = result["files"], result["classes"]
    lines = [
        "hfy-parity: verdict=%s explained=%d unexplained=%d exit=%d" % (
            result["verdict"], result["explained"], result["unexplained"], exit_code),
        "files compared: legacy %d, shadow %d; identical %d; differing only by normalisation %d" % (
            files["legacy"], files["shadow"], files["identical"], files["normalised_only"]),
        "",
        "%-16s %10s %12s" % ("class", "explained", "unexplained"),
    ]
    for cls in compare_mod.CLASSES:
        lines.append("%-16s %10d %12d" % (cls, classes[cls]["explained"], classes[cls]["unexplained"]))
    if result["rules"]:
        lines += ["", "%-26s %14s %8s %14s  %s" % ("rule", "only_in_legacy", "changed", "only_in_render", "areas")]
        for rule, row in result["rules"].items():
            lines.append("%-26s %14d %8d %14d  %s" % (rule, row["only_in_legacy"], row["changed"], row["only_in_render"],
                                                      _pairs(row["areas"])))
    if result["normalised"]:
        lines += ["", "normalised, not differences: " + _pairs(result["normalised"])]
    if result["unexplained_by_area"]:
        lines += ["", "unexplained by area: " + _pairs(result["unexplained_by_area"])]
    if result["unexplained_by_field"]:
        lines.append("unexplained by field: " + _pairs(result["unexplained_by_field"]))
    if result["not_compared"]:
        lines += ["", "not compared, legacy files the renderer does not own: " + _pairs(result["not_compared"])]
    return "\n".join(lines) + "\n"


def _term(_signum: int, _frame: Any) -> None:
    raise SystemExit(143)  # lets the temp folder's cleanup run


def main(argv: Optional[List[str]] = None, run: Callable = subprocess.run,
         out: Optional[TextIO] = None, err: Optional[TextIO] = None) -> int:
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr

    def fail(code: int, word: str) -> int:
        err.write("hfy-parity: %s\n" % word)
        return code

    try:
        args = _parser(err).parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else EXIT_USAGE

    prefix = None
    if args.shadow.startswith("s3://"):
        prefix = source.normalise_prefix(args.shadow)
        if prefix is None:
            return fail(EXIT_USAGE, "shadow_prefix_must_end_in_render-shadow")

    try:
        if not os.path.isdir(args.legacy):
            return fail(EXIT_LEGACY, "legacy_missing")
        legacy = source.scan_dir(args.legacy)
        if not any(compare_mod.is_owned(key) for key in legacy):
            return fail(EXIT_LEGACY, "legacy_empty")
        try:
            policy = rules.load_policy()
        except (OSError, ValueError, KeyError, TypeError):
            return fail(EXIT_INTERNAL, "policy_unreadable")

        if prefix is None:
            if not os.path.isdir(args.shadow):
                return fail(EXIT_SHADOW, "shadow_missing")
            shadow = source.scan_dir(args.shadow)
            if not any(compare_mod.is_owned(key) for key in shadow):
                return fail(EXIT_SHADOW, "shadow_empty")
            result = compare_mod.compare(legacy, shadow, policy)
        else:
            previous = None
            try:
                previous = signal.signal(signal.SIGTERM, _term)
            except ValueError:  # not the main thread
                pass
            try:
                with source.temp_dir() as tmp:
                    try:
                        source.fetch_s3(prefix, tmp, run=run)
                    except source.ShadowUnreachable:
                        return fail(EXIT_SHADOW, "shadow_unreachable")
                    shadow = source.scan_dir(tmp)
                    if not any(compare_mod.is_owned(key) for key in shadow):
                        return fail(EXIT_SHADOW, "shadow_empty")
                    result = compare_mod.compare(legacy, shadow, policy)
            finally:
                if previous is not None:
                    signal.signal(signal.SIGTERM, previous)
    except Exception as exc:  # noqa: BLE001 - the message of an exception can quote a key or a value: print the class only
        return fail(EXIT_INTERNAL, "internal_error (%s)" % type(exc).__name__)

    code = _VERDICT_EXIT[result["verdict"]]
    if args.json:
        out.write(json.dumps(dict(result, exit=code), indent=2, sort_keys=True) + "\n")
    else:
        out.write(format_report(result, code))
    return code
