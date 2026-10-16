// The staging entry (chat.md sections 17.1 and 20.3): the production wiring of index.mjs with two stand-ins, so the Worker
// and the hub can be exercised end to end on workers.dev, or under `wrangler dev`, with nothing of production behind them.
//
//   - Sessions are verified against the TEST_JWKS var (a test key pair made by `npm run staging:keys`), not a fetched JWKS.
//   - The hub's API is a stand-in: the directory is STAGING_MEMBERS synthetic ids, pushes and archive batches are accepted.
//
// `wrangler.toml` points only [env.staging] at this file. It is never part of dist/, so production cannot reach it.
import { ChatHub as KitHub, createChatWorker } from "@io-kit/chat/cloudflare";
import { contactGuard, makeHandler } from "./common.mjs";
import { withExpunge } from "./expunge.mjs";

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A stand-in for hfy-api's three chat routes. It checks only that a bearer token was sent. */
export function stagingApi(env) {
  const count = Math.min(Math.max(Number.parseInt(env.STAGING_MEMBERS ?? "400", 10) || 0, 0), 2000);
  const members = Array.from({ length: count }, (_, i) => ({ id: `I${9001 + i}`, label: `Tester ${i + 1}` }));
  return async function fetchApi(url, init) {
    const path = new URL(url).pathname.replace(/^.*\/chat\//, "/chat/");
    const headers = new Headers(init.headers);
    if (!/^Bearer \S+$/.test(headers.get("authorization") ?? "")) return new Response("{}", { status: 401 });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (path === "/chat/directory") return ok({ version: 1, generated_at: new Date().toISOString(), members });
    if (path === "/chat/push") return ok({ sent: 0, skipped: (body.items ?? []).length });
    if (path === "/chat/archive") {
      const msgs = body.msgs ?? [];
      return ok({ stored: msgs.length, through_seq: msgs.reduce((m, x) => Math.max(m, x.seq), 0) });
    }
    return new Response("{}", { status: 404 });
  };
}

export class ChatHub extends withExpunge(KitHub) {
  constructor(ctx, env) {
    super(ctx, env, { contactGuard, fetch: stagingApi(env) });
  }
}

const workers = new Map();
function workerFor(env) {
  const jwks = env.TEST_JWKS ?? "";
  let w = workers.get(jwks);
  if (!w) {
    w = createChatWorker({
      fetch: async () => (jwks ? new Response(jwks, { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 })),
    });
    workers.set(jwks, w);
  }
  return w;
}

export default { fetch: makeHandler(workerFor) };
