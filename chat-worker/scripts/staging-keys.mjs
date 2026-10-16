// Makes the staging test keys: an RSA pair for `io_id` cookies and an ES256 key for the hub's service token.
// The private halves go to chat-worker/.staging/keys.json (ignored by Git, mode 0600); the public JWKS goes to the Worker as a
// var. Nothing here can load a production key: it only ever generates new ones. Run with `--force` to replace existing keys.
import { generateKeyPairSync, createPublicKey, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const KEYS_FILE = join(root, ".staging", "keys.json");

export function makeStagingKeys({ issuer = "https://chat-staging.test/auth", audience = "chat-staging-web", cookie = "io_id", kid = "staging-" + randomBytes(3).toString("hex") } = {}) {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = { ...createPublicKey(rsa.privateKey).export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    issuer,
    audience,
    cookie,
    kid,
    jwks: { keys: [publicJwk] },
    sessionPrivateJwk: rsa.privateKey.export({ format: "jwk" }),
    servicePrivatePem: ec.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (existsSync(KEYS_FILE) && !process.argv.includes("--force")) {
    console.log(`${KEYS_FILE} exists; keeping it (use --force to replace).`);
  } else {
    mkdirSync(dirname(KEYS_FILE), { recursive: true });
    writeFileSync(KEYS_FILE, `${JSON.stringify(makeStagingKeys(), null, 2)}\n`, { mode: 0o600 });
    chmodSync(KEYS_FILE, 0o600);
    console.log(`wrote ${KEYS_FILE} (private halves; ignored by Git)`);
  }
}
