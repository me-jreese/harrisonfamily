"""hfy-parity: the arguments, the counts-only report and the exit codes (HFY-TSK-370). Standard library only.

    hfy-parity --legacy <dir> --shadow <dir | s3://<bucket>/render-shadow/> [--expect-holds <n>] [--expect-stripped <n> [--stripped-sidecar <state.sqlite>]] [--expect-baseline-unhydrated <n>] [--json]

Exit codes:
    0   no difference at all (a difference that only the normalisation of generatedAt and index order hides does not count)
    10  differences exist and every one is explained by a rule
    20  at least one difference is unexplained
    64  usage error (a negative or non-integer --expect-holds, --expect-stripped or --expect-baseline-unhydrated included)
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
import re
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


def _holds_count(text: str) -> int:
    """--expect-holds: a plain non-negative integer in ASCII digits. Anything else is a usage error (the value is never echoed)."""
    if not re.fullmatch(r"[0-9]+", text):
        raise argparse.ArgumentTypeError("not a count")
    return int(text)


def _parser(err: TextIO) -> _Parser:
    parser = _Parser(prog="hfy-parity", allow_abbrev=False, err=err, description=(
        "Counts-only parity report: the shadow render against a legacy export staged at the same moment."))
    parser.add_argument("--legacy", required=True, metavar="DIR", help="the staged legacy export (person/, event/, ... at its top)")
    parser.add_argument("--shadow", required=True, metavar="DIR_OR_S3_PREFIX",
                        help="a local folder, or s3://<bucket>/render-shadow/ (downloaded read-only with your own AWS profile)")
    parser.add_argument("--expect-holds", type=_holds_count, default=None, metavar="N",
                        help="the add-on's own count of objects it held whole (counts.holds of `hfy-sync check`): up to N "
                             "whole-object absences, and their index entries, are explained as held-object; more stay unexplained")
    parser.add_argument("--expect-stripped", type=_holds_count, default=None, metavar="N",
                        help="the add-on's own count of media it sent without their GPS location (counts.media_location_stripped of "
                             "`hfy-sync push`): up to N media whose checksum differs from the legacy export's are explained as "
                             "media-location-stripped; more stay unexplained")
    parser.add_argument("--stripped-sidecar", default=None, metavar="STATE_SQLITE",
                        help="with --expect-stripped: the add-on's state.sqlite of the tree (read-only). Only the media it recorded as "
                             "sent without their location can be explained; no handle is printed")
    parser.add_argument("--expect-baseline-unhydrated", type=_holds_count, default=None, metavar="N",
                        help="the number of media whose legacy record was captured while the file was an online-only placeholder (checksum of "
                             "the empty file and size 0, or a null checksum and size with missing true) and whose shadow record holds the real "
                             "checksum and size, all else equal: up to N such media are explained as media-baseline-unhydrated; more stay "
                             "unexplained")
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
    if "holds" in result:
        lines += ["", "held objects: allowed %d, whole-object absences explained %d" % (
            result["holds"]["allowed"], result["holds"]["explained"])]
    if "stripped" in result:
        lines += ["", "media sent without their location: allowed %d, media explained %d" % (
            result["stripped"]["allowed"], result["stripped"]["explained"])]
    if "baseline_unhydrated" in result:
        lines += ["", "media whose baseline was captured before the file was available: allowed %d, media explained %d" % (
            result["baseline_unhydrated"]["allowed"], result["baseline_unhydrated"]["explained"])]
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

    stripped_handles = None
    if args.stripped_sidecar is not None:
        if args.expect_stripped is None:
            return fail(EXIT_USAGE, "stripped_sidecar_needs_expect_stripped")
        try:
            stripped_handles = source.read_stripped_handles(args.stripped_sidecar)
        except Exception:  # noqa: BLE001 - StrippedSidecarUnreadable, and anything else a hostile file can raise: one code word, no traceback
            return fail(EXIT_USAGE, "stripped_sidecar_unreadable")

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
            result = compare_mod.compare(legacy, shadow, policy, expect_holds=args.expect_holds,
                                                  expect_stripped=args.expect_stripped, stripped_handles=stripped_handles,
                                                  expect_baseline_unhydrated=args.expect_baseline_unhydrated)
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
                    result = compare_mod.compare(legacy, shadow, policy, expect_holds=args.expect_holds,
                                                  expect_stripped=args.expect_stripped, stripped_handles=stripped_handles,
                                                  expect_baseline_unhydrated=args.expect_baseline_unhydrated)
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
