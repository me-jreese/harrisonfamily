// Deploys the staging Worker (hfy-chat-worker-staging on workers.dev) from a local checkout, for the smoke script and the load
// tests (chat.md sections 17.1 and 20.3). Staging is never deployed by CI. It needs a Cloudflare login on this machine
// (`wrangler login`, or CLOUDFLARE_API_TOKEN in the environment) and nothing else: no production key, no production data.
//
//   node scripts/staging-deploy.mjs [--dry-run]
//
// It makes .staging/keys.json when absent (npm run staging:keys), deploys with the public JWKS as a var, then sets the staging
// service key as a Worker secret. The private halves never leave .staging/ except into that one secret. --dry-run builds the
// bundle and prints the command with the key material left out.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KEYS_FILE, makeStagingKeys } from "./staging-keys.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry-run");
const wrangler = join(root, "node_modules", ".bin", "wrangler");

if (!existsSync(KEYS_FILE)) {
  mkdirSync(dirname(KEYS_FILE), { recursive: true });
  writeFileSync(KEYS_FILE, `${JSON.stringify(makeStagingKeys(), null, 2)}\n`, { mode: 0o600 });
  console.log(`made ${KEYS_FILE}`);
}
const keys = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
const sha = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim() || "staging";

const deploy = ["deploy", "--env", "staging", "--var", `TEST_JWKS:${JSON.stringify(keys.jwks)}`, "--var", `SESSION_ISSUER:${keys.issuer}`,
  "--var", `SESSION_AUDIENCE:${keys.audience}`, "--var", `CHAT_WORKER_VERSION:${sha}`, ...(dry ? ["--dry-run", "--outdir", join(root, ".staging", "dry")] : [])];
console.log(`wrangler ${deploy.map((a) => (a.startsWith("{") ? "<jwks>" : a)).join(" ")}`);
const d = spawnSync(wrangler, deploy, { cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
if (d.status !== 0) process.exit(d.status ?? 1);
if (dry) process.exit(0);

const secret = spawnSync(wrangler, ["secret", "put", "CHAT_SERVICE_PRIVATE_KEY", "--env", "staging"], {
  cwd: root, input: keys.servicePrivatePem, stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
process.exit(secret.status ?? 1);
