"""Exceptions that cross the boundary between the runner and the Gramps shell (hfy_sync_tool.py)."""


class ApplyAborted(Exception):
    """Raised inside the Gramps transaction to abort it. Nothing of the apply stays in the tree. `code` names why; no content."""

    def __init__(self, code, message):
        Exception.__init__(self, "%s (%s)" % (message, code))
        self.code = code
        self.message = message


class StaleTree(ApplyAborted):
    """An object the plan touches changed after the plan was made (sync.md 8.3 step 8): re-plan."""

    def __init__(self):
        ApplyAborted.__init__(self, "stale", "The tree changed after the plan was made.")
