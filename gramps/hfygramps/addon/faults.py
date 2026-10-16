"""Fault injection at the step boundaries of a pull (HFY-TSK-205; sync.md 8.3 crash safety, 15 testing).

A test sets `HFY_SYNC_FAULT=<step>` (the run raises `FaultInjected` there, which the runner turns into a `failed` run with exit 70) or
`HFY_SYNC_FAULT=crash:<step>` (the process ends at once with `os._exit(99)`, which is what a power cut or a kill looks like: no
`finally`, no status.json, SQLite's own journal rolls an open transaction back). It is honoured only while `HFY_SYNC_TEST=1` is also
set, like the process-list seam in preflight.py, so a stray variable can never switch a real run into failing.

Steps, in the order a pull reaches them:

    after_snapshot     the snapshot was downloaded and verified
    after_media        every media file of the plan was downloaded and recorded
    after_backup       the backup and its sidecar copy exist and passed integrity_check
    mid_apply          inside the Gramps transaction, after the first half of the commits (the transaction must roll back whole)
    after_commit       the Gramps transaction committed; the sidecar is not yet updated
    after_sidecar      the sidecar was updated; status.json is not yet written

Tests can also pass `services["faults"]`, an object with `hit(step)`, to the runner.
"""
import os

STEPS = ("after_snapshot", "after_media", "after_backup", "mid_apply", "after_commit", "after_sidecar")
CRASH_EXIT = 99


class FaultInjected(Exception):
    """Raised at the named step; carries nothing but the step name."""

    def __init__(self, step):
        Exception.__init__(self, "fault injected at %s" % step)
        self.step = step


class Faults:
    """Reads the fault from the environment (test runs only). `hit(step)` does nothing unless `step` is the configured one."""

    def __init__(self, environ=None, exit_fn=os._exit):
        environ = os.environ if environ is None else environ
        spec = environ.get("HFY_SYNC_FAULT", "") if environ.get("HFY_SYNC_TEST") == "1" else ""
        self.crash = spec.startswith("crash:")
        self.step = spec[len("crash:"):] if self.crash else spec
        if self.step and self.step not in STEPS:
            self.step = ""  # an unknown name is ignored, never a surprise failure
        self._exit = exit_fn

    def hit(self, step):
        if self.step and step == self.step:
            if self.crash:
                self._exit(CRASH_EXIT)
            raise FaultInjected(step)


class NoFaults:
    def hit(self, step):
        return None
