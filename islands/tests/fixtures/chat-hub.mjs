// A real chat hub for the browser specs (HFY-TSK-142, chat.md 19.4): the kit's ChatCore over its MemoryStore, bridged to the page's
// WebSocket with Playwright's page.routeWebSocket('/chat/ws'). The wire is the production one (protocol v1 frames, the same R-18
// contactGuard the Worker bundles), the clock is the real one, and nothing leaves the machine. Synthetic people only: ids I9001..
//
//   const hub = chatHub({ people: PEOPLE });
//   await hub.attach(page, { uid: "I9001" });           // the page's sockets are this user's
//   const pat = hub.virtual("I9002");                    // a second member who needs no browser: pat.send(frame), pat.received
import { ChatCore, MemorySocketTable, MemoryStore } from "@io-kit/chat/server";
import { contactGuard } from "../../src/lib/chat-guard.js";

export const PEOPLE = [
  { id: "I9001", label: "Sam Example" },
  { id: "I9002", label: "Pat Example" },
  { id: "I9003", label: "Alex Example" },
  { id: "I9004", label: "Kim Example" },
  { id: "I9005", label: "Robin Example" },
];

export function chatHub({ people = PEOPLE, core: coreOptions = {} } = {}) {
  const store = new MemoryStore();
  const core = new ChatCore({ store, sockets: new MemorySocketTable(), contactGuard, ...coreOptions });
  core.applyDirectory(people, Date.now());
  const ends = new Map(); // socket id -> { send(text), close(code, reason) }
  const log = { sockets: 0, frames: [] }; // every client frame the hub decoded, with the user: what the page really sent
  let n = 0;
  const deliver = (fx) => {
    for (const e of fx) {
      const end = ends.get(e.to);
      if (!end) continue;
      if (e.kind === "send") end.send(JSON.stringify(e.frame));
      else { ends.delete(e.to); end.close(e.code, e.reason ?? ""); }
    }
  };
  const timer = setInterval(() => deliver(core.tick(Date.now())), 1000);
  timer.unref?.();

  const open = (uid, exp, end) => {
    const id = `s${++n}`;
    ends.set(id, end);
    log.sockets += 1;
    deliver(core.connect(id, { uid, exp }, Date.now()));
    return {
      id,
      receive: (text) => {
        try { log.frames.push({ uid, frame: JSON.parse(text) }); } catch { /* a malformed frame is the core's to refuse */ }
        deliver(core.handle(id, text, Date.now()));
      },
      gone: () => { ends.delete(id); deliver(core.disconnect(id, Date.now())); },
    };
  };

  return {
    core,
    store,
    log,
    /** The page's WebSockets to /chat/ws become sockets of `uid` (session expiry `exp`, epoch seconds, or a function that gives it at each connect, as the Worker reads it from the cookie). `refuse` closes each upgrade with that code instead. */
    async attach(page, { uid, exp = () => Math.floor(Date.now() / 1000) + 3600, refuse = null }) {
      await page.routeWebSocket(/\/chat\/ws/, (ws) => {
        log.upgrades = (log.upgrades ?? 0) + 1;
        if (refuse) { ws.close({ code: refuse, reason: "refused" }); return; }
        const sock = open(uid, typeof exp === "function" ? exp() : exp, { send: (t) => ws.send(t), close: (code, reason) => ws.close({ code, reason }) });
        ws.onMessage((m) => sock.receive(typeof m === "string" ? m : Buffer.from(m).toString("utf8")));
        ws.onClose(() => sock.gone());
      });
    },
    /** A member with no browser: connects and says hello at once; `send` puts a frame on the wire; `received` holds what the hub sent. */
    virtual(uid, { hello = true, vis = true } = {}) {
      const received = [];
      const sock = open(uid, Math.floor(Date.now() / 1000) + 3600, { send: (t) => received.push(JSON.parse(t)), close: () => {} });
      const peer = {
        uid,
        received,
        send: (frame) => sock.receive(JSON.stringify(frame)),
        frames: (t) => received.filter((f) => f.t === t),
        close: () => sock.gone(),
        say: (conv, text) => peer.send({ t: "send", conv, cmid: `v-${uid}-${++n}`, text }),
      };
      if (hello) peer.send({ t: "hello", v: 1, sid: `virtual-${uid}-${n}`, vis });
      return peer;
    },
    dispose() { clearInterval(timer); ends.clear(); },
  };
}

/** The canonical direct-chat id of two members (the code-point order of the ids). */
export const dm = (a, b) => (a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`);
