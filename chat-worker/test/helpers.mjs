// Test rig for the committed bundle (dist/index.js): the Workers runtime pieces Node lacks (WebSocketPair, a 101 Response,
// WebSocketRequestResponsePair), a fake Durable Object namespace and state, and a console spy. Synthetic ids and keys only.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FakeApi, FakeDurableObjectState, makeEcKey, openNodeSqlite } from "@io-kit/chat/testing";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const distFile = join(root, "dist", "index.js");
export const loadBundle = () => import(pathToFileURL(distFile).href);

const RealResponse = globalThis.Response;

/** `new Response(null, {status: 101, webSocket})` throws in Node; the Workers runtime allows it. */
class WorkersResponse extends RealResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(null, { status: 200 });
      Object.defineProperty(this, "status", { value: 101 });
      Object.defineProperty(this, "webSocket", { value: init.webSocket });
    } else super(body, init);
  }
}

/**
 * Install the globals the bundle reads at call time. `pair` makes the two ends of a WebSocketPair. Returns `restore()`.
 */
export function installShims({ pair }) {
  const saved = {
    Response: globalThis.Response,
    WebSocketPair: globalThis.WebSocketPair,
    Pair: globalThis.WebSocketRequestResponsePair,
  };
  globalThis.Response = WorkersResponse;
  globalThis.WebSocketPair = class {
    constructor() {
      const [client, server] = pair();
      this[0] = client;
      this[1] = server;
    }
  };
  globalThis.WebSocketRequestResponsePair = class {
    constructor(request, response) {
      this.request = request;
      this.response = response;
    }
  };
  return () => {
    globalThis.Response = saved.Response;
    if (saved.WebSocketPair === undefined) delete globalThis.WebSocketPair;
    else globalThis.WebSocketPair = saved.WebSocketPair;
    if (saved.Pair === undefined) delete globalThis.WebSocketRequestResponsePair;
    else globalThis.WebSocketRequestResponsePair = saved.Pair;
  };
}

/** Records every console call as one string, so a test can search the whole output. */
export function spyConsole() {
  const lines = [];
  const saved = {};
  for (const m of ["log", "info", "warn", "error", "debug", "trace", "dir"]) {
    saved[m] = console[m];
    console[m] = (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : safeJson(x))).join(" "));
  }
  return {
    lines,
    text: () => lines.join("\n"),
    restore() {
      for (const m of Object.keys(saved)) console[m] = saved[m];
    },
  };
}
const safeJson = (x) => {
  try { return JSON.stringify(x); } catch { return String(x); }
};

/** A Durable Object namespace that records `idFromName` and `get`, and answers with a stub that records the request. */
export function fakeNamespace(reply = () => new Response("hub")) {
  const calls = { idFromName: [], get: [], requests: [] };
  return {
    calls,
    idFromName(name) {
      calls.idFromName.push(name);
      return { name };
    },
    get(id, options) {
      calls.get.push({ id, options });
      return {
        async fetch(request) {
          calls.requests.push(request);
          return reply(request);
        },
      };
    },
  };
}

/** The bundled ChatHub on a fake Durable Object state with SQLite from node:sqlite and a stand-in API (globalThis.fetch). */
export async function bundledHub({ env = {}, users = 6 } = {}) {
  const { ChatHub } = await loadBundle();
  const db = await openNodeSqlite();
  const state = new FakeDurableObjectState(db);
  const key = await makeEcKey();
  const api = new FakeApi();
  api.directory = Array.from({ length: users }, (_, i) => ({ id: `I${9001 + i}`, label: `person ${i + 1}` }));
  const fullEnv = { API_BASE: "https://api.test/api", CHAT_OPEN_TO: "all", CHAT_SERVICE_KID: "hfy-chat-1", CHAT_SERVICE_PRIVATE_KEY: key.pem, ...env };
  const restoreShims = installShims({ pair: () => [{}, state.newSocket()] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => api.fetch(String(url), init ?? {});
  const hub = new ChatHub(state, fullEnv);
  await state.blocking;
  const rig = {
    ChatHub, hub, state, api, env: fullEnv, serviceKey: key,
    async connect(uid, { exp = Math.floor(Date.now() / 1000) + 3600, hello = true } = {}) {
      const res = await hub.fetch(new Request("https://chat-hub.internal/ws", { headers: { upgrade: "websocket", "x-chat-uid": uid, "x-chat-exp": String(exp) } }));
      if (res.status !== 101) throw new Error(`hub answered ${res.status}`);
      const ws = state.accepted[state.accepted.length - 1].ws;
      const client = { ws, uid, frames: () => ws.sent.map((s) => JSON.parse(s)), send: (f) => hub.webSocketMessage(ws, typeof f === "string" ? f : JSON.stringify(f)) };
      if (hello) await client.send({ t: "hello", v: 1, sid: `tab-${state.accepted.length}`, vis: true });
      return client;
    },
    close() {
      restoreShims();
      globalThis.fetch = realFetch;
      db.close();
    },
  };
  return rig;
}
