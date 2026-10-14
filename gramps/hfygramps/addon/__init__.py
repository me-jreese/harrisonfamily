"""The desktop addon's runtime (HFY-TSK-179, sync.md section 8): everything the `hfy_sync` Gramps tool and the `hfy-sync`
wrapper decide, in standard-library Python 3.9 or later with no Gramps import, so CI can test it.

The Gramps-facing shell is `gramps/hfy_sync/hfy_sync_tool.py`; it builds a `runner.TreeAccess` from the open database and calls
`runner.run`. Modules: `consts` (versions, exit codes, key names), `paths` (the application-support layout, sync.md 4.3),
`status` (status.json), `sidecar` (state.sqlite), `binding` (dbid, tree marker, similarity guard), `preflight` (the refusals) and
`runner` (the run sequence this skeleton implements: preflight, binding, then the action).
"""
