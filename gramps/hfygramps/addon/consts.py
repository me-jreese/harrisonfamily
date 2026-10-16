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

ACTIONS = ("status", "login", "check", "pull", "push", "sync", "bind")
IMPLEMENTED_ACTIONS = ("status", "bind", "login", "push")  # check, pull and sync wait for addon-pull-apply
# Gramps classes in the order a push sends them (sync.md 8.3 step 12); the sidecar `base.class` column uses these names.
CLASSES = ("Tag", "Place", "Note", "Source", "Repository", "Citation", "Media", "Event", "Person", "Family")

# status.json "result"
OK, CHANGES_PENDING, PARTIAL, REFUSED, FAILED = "ok", "changes_pending", "partial", "refused", "failed"
RESULTS = (OK, CHANGES_PENDING, PARTIAL, REFUSED, FAILED)

# status.json "next_action": sync.md 4.3, plus `bind` and `rebase` (BRD2 D50) for the two binding recoveries
NEXT_ACTIONS = ("none", "login", "step_up", "resolve_conflicts", "retry", "update_addon", "open_bound_tree", "close_gramps",
                "bind", "rebase")

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
NOT_ENABLED = (EXIT_NOT_ENABLED, "none", "This build of the addon has no pull yet; status, bind, login and push are available.")
REFUSALS["config_unreadable"] = (EXIT_CONFIG, "none", "config.json is unreadable. Fix or remove it, then bind the tree again; the tree and the website are untouched.")
REFUSALS["unbound"] = (EXIT_CONFIG, "bind", "This tree is not bound to the website yet. Bind it first (hfy-sync bind --yes).")
REFUSALS["usage"] = (EXIT_USAGE, "none", "Unknown action or option. Use status, bind, login or push in this build.")

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
    "object_too_large": "This record is larger than the website accepts and was not sent.",
    "merge_held": "A person merge is held until the website can re-key what depends on the merged ID. Nothing was sent for it.",
    "merge_member_principal": "The merged-away person is a signed-in family member. Merge the other way: keep this person and merge the other into them.",
    "merge_unverified": "The website did not say which people are signed-in members, so a merge cannot be checked. Nothing was sent for it.",
    "merge_gui_only": "A person merge is only pushed from the Gramps window, with a fresh sign-in. Nothing was sent for it.",
    "delete_parked": "A delete is only pushed with --allow-deletes. Nothing was sent for it.",
    "step_up_required": "A delete needs a fresh sign-in (hfy-sync login --step-up). Nothing was sent for it.",
    "mass_delete": "Too many deletes at once (more than 10, or more than 5 percent of the synced records). Nothing was sent; do it from the Gramps window.",
    "privacy_violation": "The website refused this record's content (a rule differs between the addon and the website). Nothing of it is stored.",
    "integrity_violation": "The website found a reference to a record it does not have. This record will be sent again on the next run.",
    "exists": "The website already has a record with this handle.",
}
