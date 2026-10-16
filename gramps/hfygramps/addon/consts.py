"""Names, versions and exit codes of the desktop addon (sync.md 4.3, 8.6, 8.7, 17)."""
ADDON_ID = "hfy_sync"
ADDON_VERSION = "0.1.0"  # also in hfy_sync.gpr.py and checked equal by a unit test

GRAMPS_SERIES = (6, 0)  # D04: the Gramps major.minor the addon runs under
SUPPORTED_DB_SCHEMAS = (21,)  # D04: Gramps database schema versions the addon reads (sync.md 8.3 step 1)
STATUS_SCHEMA = 1  # status.json "schema"
SIDECAR_SCHEMA = 1  # sidecar meta key sidecar_schema
REDACTION_VERSION = 1  # redaction-v1

TREE_MARKER_KEY = "hfy_sync_tree_id"  # Gramps metadata key written into the tree at bind (BRD2 section 11, 8.3 step 1)
SIMILARITY_MIN_PERCENT = 90  # at least this share of the sidecar base handles must exist locally, else D03
DEFAULT_SERVER = "https://harrisonfamily.us"
DEFAULT_MEDIA_ROOT = "~/Pictures/hfy-sync-media"
DELTA_VERIFY_EVERY = 7  # ARCH-B (delta.py): every 7th sync downloads the full snapshot and checks the delta replay against it

# Transport and sign-in (sync.md 7.1, 8.1, 8.5; HFY-TSK-180)
SYSTEM_CA_FILE = "/etc/ssl/cert.pem"  # the fallback when Gramps' bundled Python has an empty default trust store (R2-08)
RETRY_DELAYS_S = (1, 4, 16)  # idempotent calls retry three times at these gaps
HTTP_TIMEOUT_S = 30
LOGIN_TIMEOUT_S = 300  # sync.md 8.5: the loopback server waits five minutes
OAUTH_CLIENT_ID = "hfy-sync-desktop"
SYNC_RESOURCE = "https://harrisonfamily.us/api/sync"  # the production resource; any other server derives <server>/api/sync (oauth.sync_resource)
CALLBACK_CONN_TIMEOUT_S = 5  # a loopback connection that sends nothing is dropped after this long
OAUTH_SCOPE = "sync"
STEP_UP_MAX_AGE_S = 300
KEYCHAIN_SERVICE = "us.harrisonfamily.hfy_sync"  # sync.md 6
# sync.md 6 names the account "<issuer>|<sub>". The refresh path has to find the item before any token (so any `sub`) is known, so
# the account is "<issuer>|owner": one item per issuer, and a new sign-in replaces it. Recorded as a deviation in gramps/README.md.
KEYCHAIN_ACCOUNT_OWNER = "owner"
KEYCHAIN_ACCOUNT = DEFAULT_SERVER + "/auth|" + KEYCHAIN_ACCOUNT_OWNER

ACTIONS = ("status", "login", "check", "pull", "push", "sync", "bind", "rebase", "restore")
IMPLEMENTED_ACTIONS = ("status", "bind", "login", "check", "pull", "push", "sync", "rebase", "restore")  # `sync` runs the pull half only; `push` is its own action
PULL_ACTIONS = ("check", "pull", "sync")  # the actions that run the pull side (sync.md 8.3 steps 3 to 11)
# Gramps classes in the order a push sends them (sync.md 8.3 step 12); the sidecar `base.class` column uses these names.
CLASSES = ("Tag", "Place", "Note", "Source", "Repository", "Citation", "Media", "Event", "Person", "Family")

# status.json "result"
OK, CHANGES_PENDING, PARTIAL, REFUSED, FAILED = "ok", "changes_pending", "partial", "refused", "failed"
RESULTS = (OK, CHANGES_PENDING, PARTIAL, REFUSED, FAILED)

# status.json "next_action": sync.md 4.3, plus `bind` and `rebase` (BRD2 D50) for the two binding recoveries
NEXT_ACTIONS = ("none", "login", "step_up", "resolve_conflicts", "retry", "update_addon", "open_bound_tree", "close_gramps",
                "bind", "rebase", "review_incidents", "review_preview")

# Exit codes of the wrapper (sync.md 8.7)
EXIT_OK = 0
EXIT_DRY_RUN_CHANGES = 10
EXIT_PARTIAL = 20
EXIT_USAGE = 64
EXIT_SERVER_REFUSED = 65
EXIT_NOT_ENABLED = 69
EXIT_INTERNAL = 70
EXIT_TEMPORARY = 75
EXIT_SIGN_IN = 77
EXIT_CONFIG = 78

# The refusals of this skeleton, from the error catalog (sync.md 17): id -> (exit code, next_action, message).
# Messages carry no object content, only what the catalog row says.
REFUSALS = {
    "D01": (EXIT_TEMPORARY, "close_gramps", "The tree is open in Gramps. Close Gramps, or use the Website sync tool from inside it."),
    "D02": (EXIT_USAGE, "none", "--force-unlock is never allowed with the website sync. Run again without it."),
    "D03": (EXIT_CONFIG, "open_bound_tree", "This is not the tree bound to the website. Open the bound tree; rebinding needs a fresh sign-in."),
    "D04": (EXIT_CONFIG, "update_addon", "This Gramps version or database schema is not supported by the installed addon. Update the addon first."),
    "D12": (EXIT_CONFIG, "rebase", "The sync state for this tree is missing. Rebase it from the Gramps window; nothing is sent automatically."),
    "D13": (EXIT_CONFIG, "rebase", "The sync state for this tree is damaged or from a newer addon. Rebase it from the Gramps window."),
    "D14": (EXIT_TEMPORARY, "retry", "Another website sync run is in progress. Wait for it to finish."),
}
NOT_ENABLED = (EXIT_NOT_ENABLED, "none", "This action is not in this build of the addon; status, bind, login, check, pull, push, sync (the pull half) and restore are available.")
REFUSALS["config_unreadable"] = (EXIT_CONFIG, "none", "config.json is unreadable. Fix or remove it, then bind the tree again; the tree and the website are untouched.")
REFUSALS["usage"] = (EXIT_USAGE, "none", "Unknown action or option. See hfy-sync for the list of actions.")
REFUSALS["unbound"] = (EXIT_CONFIG, "bind", "This tree is not bound to the website yet. Bind it first (hfy-sync bind --yes); nothing was read or sent.")
EDITORS_OPEN_MESSAGE = "close open edit windows to sync"  # D45, verbatim in the window and in the refusal
REFUSALS["D45"] = (EXIT_TEMPORARY, "retry", "A Gramps edit window is open: %s, then apply again." % EDITORS_OPEN_MESSAGE)
REFUSALS["D50"] = (EXIT_CONFIG, "rebase", "The website's store is a different cloud tree than the one this tree last synced with (a re-seed or recovery). Rebase it from the Gramps window; nothing is sent automatically.")
REFUSALS["disk_space"] = (EXIT_TEMPORARY, "none", "Not enough free disk space for the backup (three times the database plus 100 MB). Free some space and run again; nothing was changed.")
REFUSALS["restore_open"] = (EXIT_TEMPORARY, "close_gramps", "A restore needs the tree closed. Close Gramps and run hfy-sync restore from the command line.")

# Gramps' own option tables (gramps/gen/const.py, 6.0.6), for the --force-unlock check by getopt's own rules.
GRAMPS_SHORTOPTS = "O:U:P:C:i:e:f:a:p:d:c:r:lLthuv?syqSD:"
GRAMPS_LONGOPTS = ["action=", "class=", "config=", "debug=", "default=", "display=", "disable-sound", "disable-crash-dialog",
                   "enable-sound", "espeaker=", "export=", "force-unlock", "format=", "gdk-debug=", "gdk-no-debug=",
                   "gtk-debug=", "gtk-no-debug=", "gtk-module=", "g-fatal-warnings", "help", "import=", "load-modules=",
                   "listname=", "oaf-activate-iid=", "oaf-ior-fd=", "oaf-private", "open=", "username=", "password=",
                   "create=", "options=", "safe", "screen=", "show", "sm-client-id=", "sm-config-prefix=", "sm-disable",
                   "sync", "remove=", "usage", "version", "yes", "quiet"]


# Push (HFY-TSK-206; sync.md 8.3 step 12, 8.4, BRD2 11.1)
PUSH_MAX_OPS = 24  # the server's limits.max_ops; the handshake's own numbers win when it sends them
PUSH_MAX_OBJ_BYTES = 204800
PUSH_MAX_BODY_BYTES = 2097152
PUSH_TXN_ITEMS = 100  # DynamoDB's transaction limit, which the server's batch bound mirrors (api/src/sync/apply.js)
PUSH_FIXED_TXN_ITEMS = 3
MAX_CLI_DELETES = 10  # D37: the CLI never pushes more than this many deletes in one run
MASS_DELETE_SHARE_PERCENT = 5  # D37: nor more than this share of the live base objects
MAX_DEAD_BATCH_RETRIES = 3  # refused ops are dropped and the rest re-sent at most this many times per batch
MERGED_ID_ATTRIBUTE = "Merged Gramps ID"  # sync.md 8.4: the survivor of a Person merge carries the merged-away id in this attribute
OUTBOX_KEEP = 40  # acked and rejected outbox rows kept for the run log

# Hold and block rules the push adds to the projection's own (holds.rule). Messages hold no object content.
HOLD_MESSAGES = {
    "reserved_id_block": "This ID is in the range the website uses for the records it creates; renumber this new record in Gramps.",
    "gramps_id_retired": "Gramps reused a retired website ID; renumber this new record.",  # catalog D44, verbatim
    "gramps_id_taken": "The website already has another record with this ID; renumber this new record in Gramps.",
    "renumber_blocked": "A person's ID cannot change once it is on the website. Restore the old ID in Gramps.",
    "server_refused": "The website kept refusing the records in this batch; this one was not sent. Run the push again.",
    "object_too_large": "This record is larger than the website accepts and was not sent.",
    "merge_held": "A person merge is held until the website can re-key what depends on the merged ID. Nothing was sent for it.",
    "merge_member_principal": "The merged-away person is a signed-in family member. Merge the other way: keep this person and merge the other into them.",
    "merge_unverified": "The website did not say which people are signed-in members, so a merge cannot be checked. Nothing was sent for it.",
    "merge_gui_only": "A person merge is only pushed from the Gramps window, with a fresh sign-in. Nothing was sent for it.",
    "delete_parked": "A delete is only pushed with --allow-deletes. Nothing was sent for it.",
    "revert_parked": "This change reverts a website change (origin): it puts back a value that a recent pull replaced. The command line never sends it. "
                     "Keep the website's value in Gramps, or send it from the Gramps window after confirming.",
    "step_up_required": "A delete needs a fresh sign-in (hfy-sync login --step-up). Nothing was sent for it.",
    "mass_delete": "Too many deletes at once (more than 10, or more than 5 percent of the synced records). Nothing was sent; do it from the Gramps window.",
    "privacy_violation": "The website refused this record's content (a rule differs between the addon and the website). Nothing of it is stored.",
    "integrity_violation": "The website found a reference to a record it does not have. This record will be sent again on the next run.",
    "exists": "The website already has a record with this handle.",
    "sticky_daymonth": "This event was a birth event, and a push would publish its day and month. They stay on this computer until you release "
                       "this event in the Gramps window. Nothing was sent for it.",
}
# The blocks a person can lift in the Gramps window by confirming (the window runs the push with `yes`): the command line never does.
CONFIRMABLE_RULES = ("delete_parked", "mass_delete", "revert_parked", "merge_gui_only")

# Media files (HFY-TSK-207, mediaup.py, mediafile.py): plain words, no path and no content (error catalog D29, D31, D33).
HOLD_MESSAGES.update({
    "media_blob_missing": "The file for this photo or document is not at its path in Gramps, so only its details were sent. Fix the path in Gramps, then sync again.",
    "media_blob_unreadable": "The file for this photo or document cannot be read, so only its details were sent. Check the file's permissions, then sync again.",
    "media_blob_empty": "The file for this photo or document is empty (0 bytes), so only its details were sent. Make the folder available offline, then sync again.",
    "media_blob_placeholder": "The file for this photo or document is online-only in Dropbox, so only its details were sent. Make the folder available offline, then sync again.",
    "media_blob_too_large": "The file for this photo or document is over 25 MB, so only its details were sent.",
    "media_blob_unsupported": "The website takes JPEG, PNG, GIF, TIFF and PDF files; this file is another type, so only its details were sent.",
    "media_upload_failed": "The file for this photo or document could not be uploaded, so it was not sent. Run the push again.",
    "media_upload_refused": "The website refused the file for this photo or document, so it was not sent.",
    "media_file_changed": "The file for this photo or document changed while the sync ran, so it was not sent. Run the push again.",
    "media_cloud_copy_differs": "The file for this photo or document changed on this Mac and can no longer be sent, so the website keeps the copy it has. Check the file, then sync again.",
    "media_dependency_deferred": "This record refers to a photo or document whose file could not be uploaded, so it was not sent. Run the push again.",
})

# A Media handle names a file on this disk (`media_root/<handle><ext>`) and sits in a URL path, so it is held to a strict shape wherever
# it comes from the website: the snapshot parser and the media download both refuse anything else (no separator, no "..", no escapes).
HANDLE_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
