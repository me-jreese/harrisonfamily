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

ACTIONS = ("status", "login", "check", "pull", "push", "sync", "bind", "restore")
IMPLEMENTED_ACTIONS = ("status", "bind", "login", "check", "pull", "sync", "restore")  # `push` waits for addon-push; `sync` is its pull half until then
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
NOT_ENABLED = (EXIT_NOT_ENABLED, "none", "This build of the addon cannot push to the website yet; status, bind, login, check, pull, sync (the pull half) and restore are available.")
REFUSALS["config_unreadable"] = (EXIT_CONFIG, "none", "config.json is unreadable. Fix or remove it, then bind the tree again; the tree and the website are untouched.")
REFUSALS["usage"] = (EXIT_USAGE, "none", "Unknown action or option. See hfy-sync for the list of actions.")
REFUSALS["unbound"] = (EXIT_CONFIG, "bind", "This tree is not bound to the website yet. Bind it first (hfy-sync bind --yes); nothing was read or sent.")
REFUSALS["D45"] = (EXIT_TEMPORARY, "retry", "A Gramps edit window is open. Close the open edit windows to sync, then apply again.")
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

# A Media handle names a file on this disk (`media_root/<handle><ext>`) and sits in a URL path, so it is held to a strict shape wherever
# it comes from the website: the snapshot parser and the media download both refuse anything else (no separator, no "..", no escapes).
HANDLE_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
