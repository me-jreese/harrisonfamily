var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/@io-kit/chat/dist/src/constants.js
var PROTOCOL_VERSION = 1;
var CLOSE_CODES = {
  normal: 1e3,
  goingAway: 1001,
  frameTooBig: 1009,
  serviceRestart: 1012,
  replaced: 4010,
  badFrame: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  livenessTimeout: 4408,
  versionUnsupported: 4409,
  tooManyFrames: 4429,
  disabled: 4503
};
var TIMINGS = {
  /** No input for 15 minutes: the client reports `state idle`. */
  idleMs: 9e5,
  /** Offline grace after the last socket closes. */
  graceMs: 2e4,
  /** Client ping interval. */
  pingMs: 25e3,
  /** `typing on` is re-sent at most this often while keys continue. */
  typingRefreshMs: 3e3,
  /** Quiet time after which a non-empty box sends `typing paused`. */
  typingPausedMs: 5e3,
  /** A receiver drops `on` after this long without a refresh. */
  typingExpireMs: 7e3,
  /** A receiver drops `paused` after this long without `off` or a message. */
  typingSafetyMs: 6e4,
  /** Reconnect backoff bounds (copied from the kit feed client). */
  backoffMinMs: 500,
  backoffMaxMs: 3e4
};
var LIMITS = {
  /** An inbound frame over this many bytes closes the socket with 1009. */
  frameBytes: 8192,
  /** Message text, in code points. */
  text: 1e3,
  /** Message text, in lines. */
  lines: 20,
  /** Members of a group. */
  group: 50,
  /** Group name, in code points. */
  name: 60,
  /** Rows in one `batch` on resume. */
  batch: 200
};
var DEFAULT_MEDIA_HOSTS = [
  "giphy.com",
  "tenor.com",
  "gfycat.com",
  "imgur.com",
  "i.redd.it",
  "v.redd.it",
  "media.discordapp.net",
  "cdn.discordapp.com",
  "pbs.twimg.com",
  "video.twimg.com",
  "i.pinimg.com"
];
var MEDIA_EXTENSIONS = [
  "gif",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "heic",
  "heif",
  "avif",
  "bmp",
  "svg",
  "mp4",
  "mov",
  "webm",
  "m4v",
  "mp3",
  "m4a",
  "wav"
];

// node_modules/@io-kit/chat/dist/src/frames.js
var CLIENT_FRAME_TYPES = [
  "hello",
  "send",
  "create",
  "invite",
  "leave",
  "rename",
  "policy",
  "typing",
  "state",
  "read",
  "page",
  "ping"
];
var isRec = /* @__PURE__ */ __name((v) => typeof v === "object" && v !== null && !Array.isArray(v), "isRec");
var isStr = /* @__PURE__ */ __name((v) => typeof v === "string", "isStr");
var isInt = /* @__PURE__ */ __name((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0, "isInt");
var isBool = /* @__PURE__ */ __name((v) => typeof v === "boolean", "isBool");
var ID_MAX = 128;
var isId = /* @__PURE__ */ __name((v) => isStr(v) && v.length > 0 && v.length <= ID_MAX && !/\s/.test(v), "isId");
var isConv = /* @__PURE__ */ __name((v) => isStr(v) && v.length <= ID_MAX && /^(?:dm:[^:\s]+:[^:\s]+|g:[^:\s]+)$/.test(v), "isConv");
var isPolicy = /* @__PURE__ */ __name((v) => v === "private" || v === "open", "isPolicy");
var isTyping = /* @__PURE__ */ __name((v) => v === "on" || v === "paused" || v === "off", "isTyping");
var isPres = /* @__PURE__ */ __name((v) => v === "active" || v === "idle", "isPres");
var isIdList = /* @__PURE__ */ __name((v, min) => Array.isArray(v) && v.length >= min && v.length <= LIMITS.group && v.every(isId), "isIdList");
var need = /* @__PURE__ */ __name((cond, reason) => cond ? null : reason, "need");
var first = /* @__PURE__ */ __name((...checks) => checks.find((c) => c !== null) ?? null, "first");
function checkClient(f) {
  switch (f.t) {
    case "hello": {
      const resume = f.resume;
      const resumeOk = resume === void 0 || isRec(resume) && Object.entries(resume).every(([k, n]) => isConv(k) && isInt(n));
      return first(need(isInt(f.v), "v"), need(isId(f.sid), "sid"), need(isBool(f.vis), "vis"), need(resumeOk, "resume"));
    }
    case "send":
      return first(need(isConv(f.conv), "conv"), need(isId(f.cmid), "cmid"), need(isStr(f.text), "text"));
    case "create":
      return first(need(isId(f.cmid), "cmid"), need(isIdList(f.members, 1), "members"), need(f.name === void 0 || isStr(f.name), "name"), need(isPolicy(f.policy), "policy"));
    case "invite":
      return first(need(isConv(f.conv), "conv"), need(isId(f.cmid), "cmid"), need(isIdList(f.members, 1), "members"));
    case "leave":
      return first(need(isConv(f.conv), "conv"), need(isId(f.cmid), "cmid"));
    case "rename":
      return first(need(isConv(f.conv), "conv"), need(isId(f.cmid), "cmid"), need(isStr(f.name), "name"));
    case "policy":
      return first(need(isConv(f.conv), "conv"), need(isId(f.cmid), "cmid"), need(isPolicy(f.policy), "policy"));
    case "typing":
      return first(need(isConv(f.conv), "conv"), need(isTyping(f.state), "state"));
    case "state":
      return first(need(isPres(f.s), "s"), need(isBool(f.vis), "vis"));
    case "read":
      return first(need(isConv(f.conv), "conv"), need(isInt(f.seq), "seq"));
    case "page":
      return first(need(isConv(f.conv), "conv"), need(isId(f.rid), "rid"), need(f.limit === void 0 || isInt(f.limit) && f.limit >= 1 && f.limit <= LIMITS.batch, "limit"), need(f.before === void 0 || isInt(f.before), "before"), need(f.after === void 0 || isInt(f.after), "after"), need(f.before === void 0 || f.after === void 0, "before+after"));
    case "ping":
      return null;
    default:
      return "t";
  }
}
__name(checkClient, "checkClient");
var encoder = new TextEncoder();
var label = /* @__PURE__ */ __name((t, known, reason) => typeof t === "string" && known.includes(t) ? `${t}: ${reason}` : reason, "label");
function parse(input, limitBytes) {
  let value = input;
  if (typeof input === "string") {
    if (limitBytes !== null && (input.length > limitBytes || input.length * 3 > limitBytes && encoder.encode(input).length > limitBytes)) {
      return { ok: false, reason: "frame too big", tooBig: true };
    }
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, reason: "not json" };
    }
  }
  if (!isRec(value))
    return { ok: false, reason: "not an object" };
  if (!isStr(value.t))
    return { ok: false, reason: "t" };
  return { ok: true, frame: value };
}
__name(parse, "parse");
function decodeClientFrame(input) {
  const p = parse(input, LIMITS.frameBytes);
  if (!p.ok)
    return p;
  const reason = checkClient(p.frame);
  return reason ? { ok: false, reason: label(p.frame.t, CLIENT_FRAME_TYPES, reason) } : { ok: true, frame: p.frame };
}
__name(decodeClientFrame, "decodeClientFrame");

// node_modules/@io-kit/chat/dist/src/text.js
var STRIP = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF\uFFF9-\uFFFB]/g;
function normalizeText(input) {
  return input.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(STRIP, "").trim();
}
__name(normalizeText, "normalizeText");
var codePoints = /* @__PURE__ */ __name((s) => Array.from(s).length, "codePoints");
var DATA_URI = /(?<![A-Za-z0-9])data:[^\s,]*,/i;
var URL_RE = /https?:\/\/[^\s<>"]+/gi;
function mediaUrl(raw, mediaHosts) {
  const cleaned = raw.replace(/[.,;:!?)\]}'"]+$/, "");
  let url;
  try {
    url = new URL(cleaned);
  } catch {
    return false;
  }
  let path = url.pathname.toLowerCase();
  try {
    path = decodeURIComponent(path);
  } catch {
  }
  const ext = /\.([a-z0-9]+)$/.exec(path)?.[1];
  if (ext && MEDIA_EXTENSIONS.includes(ext))
    return true;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return mediaHosts.some((h) => host === h || host.endsWith(`.${h}`));
}
__name(mediaUrl, "mediaUrl");
function checkText(input, options = {}) {
  if (typeof input !== "string")
    return { ok: false, code: "BAD_FRAME" };
  const text = normalizeText(input);
  if (text === "")
    return { ok: false, code: "EMPTY" };
  if (codePoints(text) > LIMITS.text || text.split("\n").length > LIMITS.lines)
    return { ok: false, code: "TOO_LONG" };
  if (DATA_URI.test(text))
    return { ok: false, code: "MEDIA_URL" };
  const hosts = (options.mediaHosts ?? DEFAULT_MEDIA_HOSTS).map((h) => h.trim().toLowerCase().replace(/^\*?\./, "").replace(/\.$/, ""));
  for (const m of text.matchAll(URL_RE)) {
    if (mediaUrl(m[0], hosts))
      return { ok: false, code: "MEDIA_URL" };
  }
  const spans = options.contactGuard?.(text) ?? [];
  if (spans.length > 0)
    return { ok: false, code: "CONTACT_INFO", spans: spans.map((s) => [s[0], s[1], s[2]]) };
  return { ok: true, text };
}
__name(checkText, "checkText");
function checkGroupName(input, options = {}) {
  if (typeof input !== "string")
    return { ok: false, code: "BAD_FRAME" };
  const name = normalizeText(input);
  if (name === "")
    return options.allowEmpty ? { ok: true, name } : { ok: false, code: "NAME_INVALID" };
  if (name.includes("\n") || codePoints(name) > LIMITS.name)
    return { ok: false, code: "NAME_INVALID" };
  const spans = options.contactGuard?.(name) ?? [];
  if (spans.length > 0)
    return { ok: false, code: "CONTACT_INFO", spans: spans.map((s) => [s[0], s[1], s[2]]) };
  return { ok: true, name };
}
__name(checkGroupName, "checkGroupName");

// node_modules/@io-kit/chat/dist/src/server/socket-table.js
var MemorySocketTable = class {
  static {
    __name(this, "MemorySocketTable");
  }
  map = /* @__PURE__ */ new Map();
  get(id) {
    return this.map.get(id);
  }
  set(id, meta) {
    this.map.set(id, meta);
  }
  delete(id) {
    this.map.delete(id);
  }
  ids() {
    return [...this.map.keys()];
  }
  idsOf(uid) {
    const out = [];
    for (const [id, m] of this.map)
      if (m.uid === uid)
        out.push(id);
    return out;
  }
};

// node_modules/@io-kit/chat/dist/src/server/store.js
var VISIBILITY_MS = 2592e6;
var ID_RE = /^[^:\s]+$/;
function compareCodePoints(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const cx = x[i]?.codePointAt(0) ?? 0;
    const cy = y[i]?.codePointAt(0) ?? 0;
    if (cx !== cy)
      return cx < cy ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}
__name(compareCodePoints, "compareCodePoints");
function parseDm(id) {
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== "dm")
    return null;
  const a = parts[1] ?? "";
  const b = parts[2] ?? "";
  return ID_RE.test(a) && ID_RE.test(b) ? [a, b] : null;
}
__name(parseDm, "parseDm");

// node_modules/@io-kit/chat/dist/src/server/ulid.js
var ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function newUlid(now = Date.now(), random) {
  const bytes = random ? random(10) : globalThis.crypto.getRandomValues(new Uint8Array(10));
  let t = Math.max(0, Math.floor(now));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let bits = 0;
  let acc = 0;
  let rand = "";
  for (const b of bytes) {
    acc = acc << 8 | b;
    bits += 8;
    while (bits >= 5) {
      rand += ALPHABET[acc >> bits - 5 & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return time + rand;
}
__name(newUlid, "newUlid");

// node_modules/@io-kit/chat/dist/src/server/core.js
var MAX_SOCKETS_PER_USER = 10;
var REAUTH_LEAD_MS = 12e4;
var EXPIRY_GRACE_MS = 6e4;
var LIVENESS_VISIBLE_MS = 6e4;
var LIVENESS_HIDDEN_MS = 15e4;
var SWEEP_EVERY_MS = 3e4;
var ARCHIVE_EVERY_MS = 6e5;
var ARCHIVE_BATCH_MSGS = 100;
var PUSH_BATCH = 50;
var PUSH_BACKOFF_MS = [6e4, 3e5, 18e5];
var RESUME_CAP = LIMITS.batch;
var RESUME_MAX_CONVS = 100;
var HELLO_TIMEOUT_MS = 1e4;
var dmCreateKey = /* @__PURE__ */ __name((id) => `dm ${id}`, "dmCreateKey");
var DEFAULT_PAGE = 50;
var freshBuckets = /* @__PURE__ */ __name((now) => ({
  send: { n: 10, t: now },
  create: { n: 10, t: now },
  invite: { n: 20, t: now },
  page: { n: 10, t: now },
  all: { w: now, c: 0 },
  over: 0,
  tt: {}
}), "freshBuckets");
function take(b, cap, perSec, now) {
  const elapsed = Math.max(0, now - b.t);
  b.n = Math.min(cap, b.n + elapsed / 1e3 * perSec);
  b.t = now;
  if (b.n >= 1) {
    b.n -= 1;
    return 0;
  }
  return Math.ceil((1 - b.n) / perSec * 1e3);
}
__name(take, "take");
var ERR_TEXT = {
  PACE_WAIT: "they are offline. you can send another message after they reply.",
  CONTACT_INFO: "chat can't carry phone numbers or addresses.",
  MEDIA_URL: "chat is text and emoji only.",
  TOO_LONG: "that message is too long.",
  EMPTY: "there is nothing to send.",
  NAME_INVALID: "that name can't be used.",
  NOT_MEMBER: "you are not in this chat.",
  NOT_ALLOWED: "that isn't allowed here.",
  UNKNOWN_USER: "that person can't use chat yet.",
  UNKNOWN_CONV: "that chat doesn't exist.",
  ALREADY_MEMBER: "they are already in this chat.",
  GROUP_FULL: "a group can have up to 50 people.",
  RATE_LIMITED: "slow down a little.",
  BAD_FRAME: "that wasn't understood.",
  SERVER_ERROR: "something went wrong. try again."
};
var ChatCore = class {
  static {
    __name(this, "ChatCore");
  }
  opts;
  store;
  sockets;
  dirCache = null;
  constructor(opts) {
    this.opts = opts;
    this.store = opts.store;
    this.sockets = opts.sockets ?? new MemorySocketTable();
  }
  // ---------------------------------------------------------------- directory
  directoryMap() {
    if (!this.dirCache)
      this.dirCache = new Map(this.store.directory().map((p) => [p.id, p.label]));
    return this.dirCache;
  }
  /** True when the user is in the current directory snapshot (and the UAT narrowing, when on). */
  isEligible(uid) {
    return this.directoryMap().has(uid);
  }
  hasDirectory() {
    return this.store.directoryAt() !== null;
  }
  /** True when there is no snapshot or it is older than `directoryMaxAgeMs` (a hello refreshes it). */
  directoryStale(now) {
    const at = this.store.directoryAt();
    return at === null || now - at > (this.opts.directoryMaxAgeMs ?? 6e4);
  }
  /**
   * Replace the directory snapshot (CH-31). A user who dropped out loses every socket (4403), leaves `people` and
   * presence (others see them go offline), and has their queued pushes dropped. Epochs and messages are kept.
   */
  applyDirectory(members, now) {
    const fx = [];
    const uat = this.opts.openTo === "uat" ? new Set(this.opts.uatSubjects ?? []) : null;
    const next = members.filter((m) => !uat || uat.has(m.id));
    const before = new Set(this.directoryMap().keys());
    this.store.replaceDirectory(next, now);
    this.dirCache = null;
    const after = this.directoryMap();
    for (const uid of before) {
      if (after.has(uid))
        continue;
      for (const id of this.sockets.idsOf(uid))
        this.closeSocket(fx, id, CLOSE_CODES.forbidden, now, "directory");
      this.store.pushDropFor(uid);
      this.refreshPresence(fx, uid, now);
      this.log("chat.directory.dropped", { uid });
    }
    for (const row of this.store.allPresence())
      if (!after.has(row.uid))
        this.refreshPresence(fx, row.uid, now);
    return fx;
  }
  // ---------------------------------------------------------------- sockets
  /** Register an accepted socket. `hello` makes it live. Beyond 10 sockets for the user the oldest closes 4010. */
  connect(socketId, info, now) {
    const fx = [];
    const meta = {
      uid: info.uid,
      sid: "",
      ...info.exp !== void 0 ? { exp: info.exp } : {},
      at: now,
      hello: false,
      st: "active",
      vis: true,
      typ: [],
      bad: 0,
      tb: freshBuckets(now)
    };
    this.sockets.set(socketId, meta);
    const mine = this.sockets.idsOf(info.uid).map((id, i) => ({ id, at: this.sockets.get(id)?.at ?? 0, i })).sort((a, b) => a.at - b.at || a.i - b.i);
    while (mine.length > MAX_SOCKETS_PER_USER) {
      const oldest = mine.shift();
      if (oldest)
        this.closeSocket(fx, oldest.id, CLOSE_CODES.replaced, now, "cap");
    }
    if (info.exp !== void 0 && now >= info.exp * 1e3 + EXPIRY_GRACE_MS)
      this.closeSocket(fx, socketId, CLOSE_CODES.unauthenticated, now, "expired");
    return fx;
  }
  /** The host saw the socket close (or errored). Idempotent. */
  disconnect(socketId, now) {
    const fx = [];
    this.dropSocket(fx, socketId, now);
    return fx;
  }
  /** Close a socket on the host's behalf (for example 4503 when the directory is unavailable). */
  reject(socketId, code, now, reason) {
    const fx = [];
    this.closeSocket(fx, socketId, code, now, reason);
    return fx;
  }
  /** The live (post-hello) socket ids of a user. */
  liveSockets(uid) {
    return this.sockets.idsOf(uid).filter((id) => this.sockets.get(id)?.hello === true);
  }
  closeSocket(fx, id, code, now, reason) {
    const meta = this.sockets.get(id);
    if (!meta)
      return;
    fx.push({ kind: "close", to: id, code, ...reason ? { reason } : {} });
    this.log("chat.close", { code, uid: meta.uid });
    this.dropSocket(fx, id, now);
  }
  dropSocket(fx, id, now) {
    const meta = this.sockets.get(id);
    if (!meta)
      return;
    this.sockets.delete(id);
    if (!meta.hello)
      return;
    const others = this.liveSockets(meta.uid).map((s) => this.sockets.get(s)?.typ ?? []);
    for (const conv of meta.typ) {
      if (others.some((t) => t.includes(conv)))
        continue;
      this.relayTyping(fx, meta.uid, conv, "off");
    }
    this.refreshPresence(fx, meta.uid, now);
  }
  // ---------------------------------------------------------------- presence
  /** True when the user has a live socket, or closed their last one less than the grace period ago (CHAT-D5). */
  isOnline(uid, now) {
    if (this.liveSockets(uid).length > 0)
      return true;
    const row = this.store.getPresence(uid);
    return row !== null && row.graceUntil !== null && now < row.graceUntil;
  }
  refreshPresence(fx, uid, now) {
    const row = this.store.getPresence(uid);
    if (!this.isEligible(uid)) {
      if (row) {
        this.store.deletePresence(uid);
        if (row.state !== "offline")
          this.announce(fx, uid, "offline");
      }
      return;
    }
    const live = this.liveSockets(uid);
    if (live.length > 0) {
      const state = live.some((id) => this.sockets.get(id)?.st === "active") ? "active" : "idle";
      const prev = row?.state ?? "offline";
      if (prev !== state || row?.graceUntil != null) {
        this.store.putPresence({ uid, state, since: prev === state ? row?.since ?? now : now, graceUntil: null });
      }
      if (prev !== state)
        this.announce(fx, uid, state);
      return;
    }
    if (row && row.state !== "offline" && row.graceUntil === null) {
      this.store.putPresence({ ...row, graceUntil: now + (this.opts.graceMs ?? TIMINGS.graceMs) });
    }
  }
  announce(fx, subject, state) {
    for (const id of this.sockets.ids()) {
      const m = this.sockets.get(id);
      if (!m || !m.hello || m.uid === subject || !this.isEligible(m.uid))
        continue;
      fx.push({ kind: "send", to: id, frame: { t: "presence", user: subject, state } });
    }
  }
  /** After a cold start: every announced-online user without a socket gets the offline grace, so a restart doesn't flash everyone offline. */
  recover(now) {
    const fx = [];
    for (const row of this.store.allPresence())
      this.refreshPresence(fx, row.uid, now);
    return fx;
  }
  // ---------------------------------------------------------------- scheduled work
  /**
   * Timed work due at `now`: grace expiry (announce offline), `reauth` at exp - 120 s and close 4401 at exp + 60 s.
   * Safe to call at any time and as often as the host likes.
   */
  tick(now) {
    const fx = [];
    for (const row of this.store.allPresence()) {
      if (row.graceUntil === null)
        continue;
      if (this.liveSockets(row.uid).length > 0) {
        this.refreshPresence(fx, row.uid, now);
        continue;
      }
      if (now >= row.graceUntil) {
        this.store.putPresence({ uid: row.uid, state: "offline", since: now, graceUntil: null });
        if (row.state !== "offline")
          this.announce(fx, row.uid, "offline");
      }
    }
    for (const id of this.sockets.ids()) {
      const m = this.sockets.get(id);
      if (!m)
        continue;
      if (!m.hello && now - m.at > HELLO_TIMEOUT_MS) {
        this.closeSocket(fx, id, CLOSE_CODES.livenessTimeout, now, "no hello");
        continue;
      }
      if (m.exp === void 0)
        continue;
      const expMs = m.exp * 1e3;
      if (now >= expMs + EXPIRY_GRACE_MS) {
        this.closeSocket(fx, id, CLOSE_CODES.unauthenticated, now, "expired");
      } else if (m.hello && !m.rx && now >= expMs - REAUTH_LEAD_MS) {
        m.rx = true;
        this.sockets.set(id, m);
        fx.push({ kind: "send", to: id, frame: { t: "reauth", exp: m.exp } });
      }
    }
    return fx;
  }
  /** Close sockets silent for 60 s (150 s while hidden), and sockets that never said hello within 10 s. `lastSeen` is the host's last-traffic time for a socket (the auto-response timestamp). */
  sweepLiveness(now, lastSeen) {
    const fx = [];
    for (const id of this.sockets.ids()) {
      const m = this.sockets.get(id);
      if (!m)
        continue;
      if (!m.hello) {
        if (now - m.at > HELLO_TIMEOUT_MS)
          this.closeSocket(fx, id, CLOSE_CODES.livenessTimeout, now, "no hello");
        continue;
      }
      const seen = lastSeen(id) ?? m.at;
      if (now - seen > (m.vis ? LIVENESS_VISIBLE_MS : LIVENESS_HIDDEN_MS))
        this.closeSocket(fx, id, CLOSE_CODES.livenessTimeout, now, "liveness");
    }
    return fx;
  }
  /** When the host should wake the core next (a storage alarm), or null when nothing is scheduled. Never earlier than `now`. */
  nextWake(now) {
    const at = [];
    for (const row of this.store.allPresence())
      if (row.graceUntil !== null)
        at.push(row.graceUntil);
    let anyLive = false;
    for (const id of this.sockets.ids()) {
      const m = this.sockets.get(id);
      if (!m)
        continue;
      if (m.hello)
        anyLive = true;
      else
        at.push(m.at + HELLO_TIMEOUT_MS + 1);
      if (m.exp !== void 0) {
        at.push(m.exp * 1e3 + EXPIRY_GRACE_MS);
        if (m.hello && !m.rx)
          at.push(m.exp * 1e3 - REAUTH_LEAD_MS);
      }
    }
    if (anyLive)
      at.push(now + SWEEP_EVERY_MS);
    const push = this.store.pushNextAt();
    if (push !== null)
      at.push(push);
    if (this.store.archiveHasPending())
      at.push(Number(this.store.getKv("archive_at") ?? 0) + ARCHIVE_EVERY_MS);
    if (at.length === 0)
      return null;
    return Math.max(now, Math.min(...at));
  }
  // ---------------------------------------------------------------- push and archive (store side; the I/O is in server.ts)
  /** Pushes due now, up to 50. Items for users who are no longer eligible are dropped here. */
  takePush(now) {
    const due = this.store.pushDue(now, PUSH_BATCH);
    const gone = due.filter((p) => !this.isEligible(p.recipient));
    if (gone.length > 0)
      this.store.pushDelete(gone.map((p) => p.id));
    return due.filter((p) => this.isEligible(p.recipient));
  }
  pushSent(items) {
    this.store.pushDelete(items.map((p) => p.id));
  }
  /** A failed attempt: retry after 1, 5 and 30 minutes, then drop and log `chat.push.dropped` (conversation id and seq only). */
  pushFailed(items, now) {
    let retried = 0;
    let dropped = 0;
    for (const p of items) {
      const wait = PUSH_BACKOFF_MS[p.attempts];
      if (wait === void 0) {
        this.store.pushDelete([p.id]);
        this.log("chat.push.dropped", { conv: p.conv, seq: p.seq });
        dropped++;
      } else {
        this.store.pushRetry(p.id, p.attempts + 1, now + wait);
        retried++;
      }
    }
    return { retried, dropped };
  }
  archiveDue(now) {
    return this.store.archiveHasPending() && now >= Number(this.store.getKv("archive_at") ?? 0) + ARCHIVE_EVERY_MS;
  }
  /** Rows past each conversation's cursor, in order, at most 100 per batch. Marks this run time. */
  archiveTake(now) {
    this.store.setKv("archive_at", String(now));
    return this.store.archiveBatches(ARCHIVE_BATCH_MSGS, 20);
  }
  /** The cursor moves only here, after the API answered 2xx. */
  archiveDone(conv, throughSeq) {
    this.store.archiveAdvance(conv, throughSeq);
  }
  // ---------------------------------------------------------------- inbound frames
  /** Decode one inbound frame (a raw JSON string is size-checked) and handle it. */
  handle(socketId, input, now) {
    return this.handleDecoded(socketId, decodeClientFrame(input), now);
  }
  handleDecoded(socketId, decoded, now) {
    const fx = [];
    const meta = this.sockets.get(socketId);
    if (!meta)
      return fx;
    const win = meta.tb.all;
    if (now - win.w >= 1e3) {
      meta.tb.over = now - win.w < 2e3 && win.c > 30 ? meta.tb.over + 1 : 0;
      win.w = now;
      win.c = 0;
    }
    win.c += 1;
    if (meta.tb.over >= 5) {
      this.closeSocket(fx, socketId, CLOSE_CODES.tooManyFrames, now, "flood");
      return fx;
    }
    if (win.c > 30) {
      this.sockets.set(socketId, meta);
      return fx;
    }
    if (!decoded.ok) {
      if (decoded.tooBig) {
        this.closeSocket(fx, socketId, CLOSE_CODES.frameTooBig, now, "frame too big");
        return fx;
      }
      return this.badFrame(fx, socketId, meta, now);
    }
    const f = decoded.frame;
    if (!meta.hello && f.t !== "hello" && f.t !== "ping")
      return this.badFrame(fx, socketId, meta, now);
    meta.bad = 0;
    this.sockets.set(socketId, meta);
    switch (f.t) {
      case "hello":
        this.onHello(fx, socketId, meta, f, now);
        break;
      case "send":
        this.onSend(fx, socketId, meta, f, now);
        break;
      case "create":
        this.onCreate(fx, socketId, meta, f, now);
        break;
      case "invite":
        this.onInvite(fx, socketId, meta, f, now);
        break;
      case "leave":
        this.onLeave(fx, socketId, meta, f, now);
        break;
      case "rename":
        this.onRename(fx, socketId, meta, f, now);
        break;
      case "policy":
        this.onPolicy(fx, socketId, meta, f, now);
        break;
      case "typing":
        this.onTyping(fx, socketId, meta, f, now);
        break;
      case "state":
        meta.st = f.s;
        meta.vis = f.vis;
        this.sockets.set(socketId, meta);
        this.refreshPresence(fx, meta.uid, now);
        break;
      case "read":
        this.onRead(fx, socketId, meta, f);
        break;
      case "page":
        this.onPage(fx, socketId, meta, f, now);
        break;
      case "ping":
        this.sockets.set(socketId, meta);
        fx.push({ kind: "send", to: socketId, frame: { t: "pong" } });
        break;
    }
    return fx;
  }
  badFrame(fx, id, meta, now) {
    meta.bad += 1;
    this.log("chat.badframe", { uid: meta.uid });
    if (meta.bad >= 3) {
      this.closeSocket(fx, id, CLOSE_CODES.badFrame, now, "bad frames");
      return fx;
    }
    this.sockets.set(id, meta);
    this.sendErr(fx, id, "BAD_FRAME");
    return fx;
  }
  // ---------------------------------------------------------------- output helpers
  sendErr(fx, to, code, extra = {}) {
    fx.push({
      kind: "send",
      to,
      frame: {
        t: "err",
        ...extra.cmid !== void 0 ? { cmid: extra.cmid } : {},
        ...extra.conv !== void 0 ? { conv: extra.conv } : {},
        code,
        msg: extra.msg ?? ERR_TEXT[code],
        ...extra.spans ? { spans: extra.spans } : {},
        ...extra.retry ? { retry: true } : {},
        ...extra.retry_ms !== void 0 ? { retry_ms: extra.retry_ms } : {}
      }
    });
  }
  log(event, fields) {
    this.opts.log?.(event, fields);
  }
  /** Send to every live socket of the given users (only eligible ones), optionally skipping one socket. */
  fanOut(fx, uids, frame, except) {
    for (const uid of new Set(uids)) {
      if (!this.isEligible(uid))
        continue;
      const f = frame(uid);
      for (const id of this.liveSockets(uid))
        if (id !== except)
          fx.push({ kind: "send", to: id, frame: f });
    }
  }
  toMsg(r) {
    return r.kind === "msg" ? { conv: r.conv, seq: r.seq, cmid: r.cmid, from: r.from, ts: r.ts, kind: "msg", text: r.text ?? "" } : { conv: r.conv, seq: r.seq, cmid: r.cmid, from: r.from, ts: r.ts, kind: "sys", sys: r.sys ?? { op: "left" } };
  }
  summary(c, uid) {
    return {
      id: c.id,
      kind: c.kind,
      ...c.name !== null ? { name: c.name } : {},
      creator: c.creator,
      ...c.policy !== null ? { policy: c.policy } : {},
      members: this.store.currentMembers(c.id),
      lastSeq: c.lastSeq,
      lastTs: c.lastTs,
      ...c.lastMsgSeq !== null ? { lastMsgSeq: c.lastMsgSeq } : {},
      ...c.lastMsgFrom !== null ? { lastMsgFrom: c.lastMsgFrom } : {},
      readSeq: this.store.getRead(uid, c.id).readSeq
    };
  }
  convFanOut(fx, c, uids) {
    this.fanOut(fx, uids, (uid) => ({ t: "conv", conv: this.summary(c, uid) }));
  }
  // ---------------------------------------------------------------- conversation access
  /**
   * Who may act in a conversation. A direct chat id must be `dm:<a>:<b>` with a < b, a != b, both eligible and the actor
   * one of them (CH-32); anything else is NOT_MEMBER, before any storage is touched. A group needs an open epoch.
   */
  access(uid, id) {
    if (id.startsWith("dm:")) {
      const pair = parseDm(id);
      if (!pair || compareCodePoints(pair[0], pair[1]) >= 0)
        return { ok: false, code: "NOT_MEMBER" };
      if (!pair.includes(uid) || !this.isEligible(pair[0]) || !this.isEligible(pair[1]))
        return { ok: false, code: "NOT_MEMBER" };
      const peer = pair[0] === uid ? pair[1] : pair[0];
      return { ok: true, id, kind: "dm", conv: this.store.getConv(id), members: [pair[0], pair[1]], peer };
    }
    const conv = this.store.getConv(id);
    if (!conv)
      return { ok: false, code: "UNKNOWN_CONV" };
    const open = this.store.epochsOf(id, uid).some((e) => e.leftSeq === null);
    if (!open)
      return { ok: false, code: "NOT_MEMBER" };
    return { ok: true, id, kind: "group", conv, members: this.store.currentMembers(id) };
  }
  deny(fx, to, uid, conv, code, cmid) {
    if (code === "NOT_MEMBER")
      this.log("chat.denied", { uid, conv });
    this.sendErr(fx, to, code, { conv, ...cmid !== void 0 ? { cmid } : {} });
  }
  /** A repeated cmid gets the original ack and changes nothing. Keyed on the actor's own rows, so it reveals nothing else. */
  replay(fx, to, uid, conv, cmid) {
    const prior = this.store.ackFor(conv, uid, cmid);
    if (!prior)
      return false;
    fx.push({ kind: "send", to, frame: { t: "ack", cmid, conv, seq: prior.seq, ts: prior.ts } });
    return true;
  }
  limited(fx, to, meta, which, now, cmid, conv) {
    const cfg = { send: [10, 5], create: [10, 10 / 60], invite: [20, 20 / 60], page: [10, 10] }[which];
    const wait = take(meta.tb[which], cfg[0], cfg[1], now);
    if (wait === 0)
      return false;
    this.log("chat.ratelimit", { uid: meta.uid });
    this.sendErr(fx, to, "RATE_LIMITED", { ...cmid !== void 0 ? { cmid } : {}, ...conv !== void 0 ? { conv } : {}, retry: true, retry_ms: wait });
    return true;
  }
  // ---------------------------------------------------------------- hello
  onHello(fx, id, meta, f, now) {
    if (meta.hello) {
      this.badFrame(fx, id, meta, now);
      return;
    }
    if (f.v !== PROTOCOL_VERSION) {
      this.closeSocket(fx, id, CLOSE_CODES.versionUnsupported, now, "version");
      return;
    }
    if (!this.isEligible(meta.uid)) {
      this.closeSocket(fx, id, CLOSE_CODES.forbidden, now, "not eligible");
      return;
    }
    meta.sid = f.sid;
    meta.vis = f.vis;
    meta.st = "active";
    meta.hello = true;
    this.sockets.set(id, meta);
    for (const other of this.sockets.idsOf(meta.uid)) {
      const m = this.sockets.get(other);
      if (other !== id && m?.hello && m.sid === f.sid)
        this.closeSocket(fx, other, CLOSE_CODES.replaced, now, "replaced");
    }
    this.refreshPresence(fx, meta.uid, now);
    const dir = this.store.directory();
    const eligible = new Set(dir.map((p) => p.id));
    const presence = {};
    for (const row of this.store.allPresence()) {
      if (row.state !== "offline" && eligible.has(row.uid))
        presence[row.uid] = row.state;
    }
    const convs = this.store.convsOf(meta.uid);
    fx.push({
      kind: "send",
      to: id,
      frame: {
        t: "welcome",
        v: PROTOCOL_VERSION,
        me: meta.uid,
        serverTs: now,
        people: dir,
        presence,
        convs: convs.map((c) => this.summary(c, meta.uid)),
        limits: { text: LIMITS.text, lines: LIMITS.lines, group: LIMITS.group, name: LIMITS.name }
      }
    });
    for (const [conv, after] of Object.entries(f.resume ?? {}).slice(0, RESUME_MAX_CONVS)) {
      const epochs = this.store.epochsOf(conv, meta.uid);
      if (epochs.some((e) => e.leftSeq === null)) {
        const rows = this.store.visible(meta.uid, conv, { after, limit: RESUME_CAP + 1, now });
        fx.push({
          kind: "send",
          to: id,
          frame: { t: "batch", conv, msgs: rows.slice(0, RESUME_CAP).map((r) => this.toMsg(r)), more: rows.length > RESUME_CAP }
        });
      } else if (epochs.length > 0) {
        fx.push({ kind: "send", to: id, frame: { t: "conv", id: conv, removed: true } });
      }
    }
  }
  // ---------------------------------------------------------------- send
  onSend(fx, id, meta, f, now) {
    const uid = meta.uid;
    if (this.replay(fx, id, uid, f.conv, f.cmid))
      return;
    if (this.limited(fx, id, meta, "send", now, f.cmid, f.conv)) {
      this.sockets.set(id, meta);
      return;
    }
    this.sockets.set(id, meta);
    const a = this.access(uid, f.conv);
    if (!a.ok) {
      this.deny(fx, id, uid, f.conv, a.code, f.cmid);
      return;
    }
    const checked = checkText(f.text, { contactGuard: this.opts.contactGuard, mediaHosts: this.opts.mediaHosts });
    if (!checked.ok) {
      if (checked.code === "CONTACT_INFO")
        this.log("chat.policy.contact", { conv: f.conv, spans: checked.spans?.length ?? 0 });
      this.sendErr(fx, id, checked.code, { cmid: f.cmid, conv: f.conv, ...checked.spans ? { spans: checked.spans } : {} });
      return;
    }
    const draft = { cmid: f.cmid, from: uid, kind: "msg", text: checked.text, ts: now };
    const guard = {};
    if (a.kind === "dm" && a.peer !== void 0) {
      guard.pacing = { sender: uid, peerOnline: this.isOnline(a.peer, now) };
      if (!a.conv) {
        guard.create = { kind: "dm", creator: uid, name: null, policy: null, createdCmid: dmCreateKey(a.id), createdAt: now };
        guard.membership = { open: a.members.map((m) => ({ uid: m, invitedBy: m === uid ? null : uid })) };
      }
    }
    let res;
    try {
      res = this.store.append(a.id, draft, guard);
    } catch {
      this.log("chat.error", { uid, conv: a.id });
      this.sendErr(fx, id, "SERVER_ERROR", { cmid: f.cmid, conv: a.id, retry: true });
      return;
    }
    if (!res.ok) {
      if (res.reason === "pace_wait") {
        this.log("chat.pace", { uid, conv: a.id });
        this.sendErr(fx, id, "PACE_WAIT", { cmid: f.cmid, conv: a.id });
      } else if (res.reason === "duplicate") {
        fx.push({ kind: "send", to: id, frame: { t: "ack", cmid: f.cmid, conv: res.conv, seq: res.ack.seq, ts: res.ack.ts } });
      } else {
        this.sendErr(fx, id, "SERVER_ERROR", { cmid: f.cmid, conv: a.id, retry: true });
      }
      return;
    }
    const row = res.row;
    fx.push({ kind: "send", to: id, frame: { t: "ack", cmid: f.cmid, conv: a.id, seq: row.seq, ts: row.ts } });
    if (!a.conv)
      this.convFanOut(fx, res.conv, a.members);
    const msgFrame = { t: "msg", ...this.toMsg(row) };
    this.fanOut(fx, a.members, () => msgFrame, id);
    this.clearTyping(fx, meta.uid, a.id, a.members);
    for (const m of a.members) {
      if (m === uid || !this.isEligible(m) || this.liveSockets(m).length > 0)
        continue;
      try {
        this.store.armPush(m, uid, a.id, row.seq, now);
      } catch {
        this.log("chat.error", { uid: m, conv: a.id });
      }
    }
  }
  // ---------------------------------------------------------------- groups
  onCreate(fx, id, meta, f, now) {
    const uid = meta.uid;
    const prior = this.store.convByCreated(uid, f.cmid);
    if (prior && prior.kind === "group") {
      fx.push({ kind: "send", to: id, frame: { t: "ack", cmid: f.cmid, conv: prior.id, seq: 1, ts: prior.createdAt } });
      return;
    }
    if (this.limited(fx, id, meta, "create", now, f.cmid)) {
      this.sockets.set(id, meta);
      return;
    }
    this.sockets.set(id, meta);
    const others = [...new Set(f.members.filter((m) => m !== uid))];
    if (others.some((m) => !this.isEligible(m)) || others.length === 0) {
      this.sendErr(fx, id, "UNKNOWN_USER", { cmid: f.cmid });
      return;
    }
    if (others.length + 1 > LIMITS.group) {
      this.sendErr(fx, id, "GROUP_FULL", { cmid: f.cmid });
      return;
    }
    let name = null;
    if (f.name !== void 0 && f.name.trim() !== "") {
      const n = checkGroupName(f.name, { contactGuard: this.opts.contactGuard });
      if (!n.ok) {
        this.sendErr(fx, id, n.code === "BAD_FRAME" ? "NAME_INVALID" : n.code, { cmid: f.cmid, ...n.spans ? { spans: n.spans } : {} });
        return;
      }
      name = n.name;
    }
    const convId = `g:${(this.opts.newId ?? newUlid)(now)}`;
    this.commitGroupOp(fx, id, meta, convId, f.cmid, now, {
      sys: { op: "created", members: others, ...name !== null ? { name } : {}, policy: f.policy },
      guard: {
        create: { kind: "group", creator: uid, name, policy: f.policy, createdCmid: f.cmid, createdAt: now },
        membership: { open: [{ uid, invitedBy: null }, ...others.map((m) => ({ uid: m, invitedBy: uid }))] }
      },
      recipients: [uid, ...others]
    });
  }
  onInvite(fx, id, meta, f, now) {
    const uid = meta.uid;
    if (this.replay(fx, id, uid, f.conv, f.cmid))
      return;
    if (this.limited(fx, id, meta, "invite", now, f.cmid, f.conv)) {
      this.sockets.set(id, meta);
      return;
    }
    this.sockets.set(id, meta);
    const a = this.access(uid, f.conv);
    if (!a.ok) {
      this.deny(fx, id, uid, f.conv, a.code, f.cmid);
      return;
    }
    if (a.kind === "dm" || !a.conv) {
      this.deny(fx, id, uid, f.conv, "NOT_ALLOWED", f.cmid);
      return;
    }
    if (a.conv.policy === "private" && a.conv.creator !== uid) {
      this.deny(fx, id, uid, f.conv, "NOT_ALLOWED", f.cmid);
      return;
    }
    const wanted = [...new Set(f.members)];
    if (wanted.some((m) => !this.isEligible(m))) {
      this.sendErr(fx, id, "UNKNOWN_USER", { cmid: f.cmid, conv: f.conv });
      return;
    }
    const fresh = wanted.filter((m) => !a.members.includes(m));
    if (fresh.length === 0) {
      this.sendErr(fx, id, "ALREADY_MEMBER", { cmid: f.cmid, conv: f.conv });
      return;
    }
    if (a.members.length + fresh.length > LIMITS.group) {
      this.sendErr(fx, id, "GROUP_FULL", { cmid: f.cmid, conv: f.conv });
      return;
    }
    this.commitGroupOp(fx, id, meta, f.conv, f.cmid, now, {
      sys: { op: "added", who: fresh },
      guard: { membership: { open: fresh.map((m) => ({ uid: m, invitedBy: uid })) } },
      recipients: [...a.members, ...fresh]
    });
  }
  onLeave(fx, id, meta, f, now) {
    const uid = meta.uid;
    if (this.replay(fx, id, uid, f.conv, f.cmid))
      return;
    const a = this.access(uid, f.conv);
    if (!a.ok) {
      this.deny(fx, id, uid, f.conv, a.code, f.cmid);
      return;
    }
    if (a.kind === "dm") {
      this.deny(fx, id, uid, f.conv, "NOT_ALLOWED", f.cmid);
      return;
    }
    this.commitGroupOp(fx, id, meta, f.conv, f.cmid, now, {
      sys: { op: "left" },
      guard: { membership: { close: [uid] } },
      recipients: a.members,
      leaver: uid
    });
  }
  onRename(fx, id, meta, f, now) {
    const uid = meta.uid;
    if (this.replay(fx, id, uid, f.conv, f.cmid))
      return;
    const a = this.access(uid, f.conv);
    if (!a.ok) {
      this.deny(fx, id, uid, f.conv, a.code, f.cmid);
      return;
    }
    if (a.kind === "dm" || !a.conv || a.conv.creator !== uid) {
      this.deny(fx, id, uid, f.conv, "NOT_ALLOWED", f.cmid);
      return;
    }
    const n = checkGroupName(f.name, { contactGuard: this.opts.contactGuard, allowEmpty: true });
    if (!n.ok) {
      this.sendErr(fx, id, n.code === "BAD_FRAME" ? "NAME_INVALID" : n.code, { cmid: f.cmid, conv: f.conv, ...n.spans ? { spans: n.spans } : {} });
      return;
    }
    this.commitGroupOp(fx, id, meta, f.conv, f.cmid, now, {
      sys: { op: "named", name: n.name },
      guard: { patch: { name: n.name === "" ? null : n.name } },
      recipients: a.members
    });
  }
  onPolicy(fx, id, meta, f, now) {
    const uid = meta.uid;
    if (this.replay(fx, id, uid, f.conv, f.cmid))
      return;
    const a = this.access(uid, f.conv);
    if (!a.ok) {
      this.deny(fx, id, uid, f.conv, a.code, f.cmid);
      return;
    }
    if (a.kind === "dm" || !a.conv || a.conv.creator !== uid || !this.opts.allowPolicyChange) {
      this.deny(fx, id, uid, f.conv, "NOT_ALLOWED", f.cmid);
      return;
    }
    this.commitGroupOp(fx, id, meta, f.conv, f.cmid, now, {
      sys: { op: "policy", policy: f.policy },
      guard: { patch: { policy: f.policy } },
      recipients: a.members
    });
  }
  /** The shared tail of create, invite, leave, rename and policy: append one system row, then ack and fan out. */
  commitGroupOp(fx, id, meta, convId, cmid, now, op) {
    const uid = meta.uid;
    let res;
    try {
      res = this.store.append(convId, { cmid, from: uid, kind: "sys", sys: op.sys, ts: now }, op.guard);
    } catch {
      this.log("chat.error", { uid, conv: convId });
      this.sendErr(fx, id, "SERVER_ERROR", { cmid, conv: convId, retry: true });
      return;
    }
    if (!res.ok) {
      if (res.reason === "duplicate") {
        fx.push({ kind: "send", to: id, frame: { t: "ack", cmid, conv: res.conv, seq: res.ack.seq, ts: res.ack.ts } });
      } else {
        this.sendErr(fx, id, "SERVER_ERROR", { cmid, conv: convId, retry: true });
      }
      return;
    }
    fx.push({ kind: "send", to: id, frame: { t: "ack", cmid, conv: convId, seq: res.row.seq, ts: res.row.ts } });
    const stay = op.recipients.filter((u) => u !== op.leaver);
    this.convFanOut(fx, res.conv, stay);
    const frame = { t: "msg", ...this.toMsg(res.row) };
    this.fanOut(fx, op.recipients, () => frame);
    if (op.leaver !== void 0) {
      this.clearTyping(fx, op.leaver, convId, op.recipients);
      this.fanOut(fx, [op.leaver], () => ({ t: "conv", id: convId, removed: true }));
    }
  }
  // ---------------------------------------------------------------- typing, read, page
  onTyping(fx, id, meta, f, now) {
    const uid = meta.uid;
    const a = this.access(uid, f.conv);
    if (!a.ok) {
      this.deny(fx, id, uid, f.conv, a.code);
      return;
    }
    if (f.state === "off") {
      if (!meta.typ.includes(f.conv))
        return;
      meta.typ = meta.typ.filter((c) => c !== f.conv);
      this.sockets.set(id, meta);
      this.clearTyping(fx, uid, f.conv, a.members, true);
      return;
    }
    const last = meta.tb.tt[f.conv];
    if (last !== void 0 && now - last < 1e3)
      return;
    for (const c of Object.keys(meta.tb.tt))
      if (now - (meta.tb.tt[c] ?? 0) >= 1e3)
        delete meta.tb.tt[c];
    meta.tb.tt[f.conv] = now;
    if (!meta.typ.includes(f.conv))
      meta.typ.push(f.conv);
    this.sockets.set(id, meta);
    this.relayTyping(fx, uid, f.conv, f.state, a.members);
  }
  /** Relay a typing state to the other members' live sockets. Never stored. */
  relayTyping(fx, uid, conv, state, members) {
    const to = (members ?? this.membersOf(conv)).filter((m) => m !== uid);
    this.fanOut(fx, to, () => ({ t: "typing", conv, user: uid, state }));
  }
  /** The sender sent a message (or left): their typing in that conversation ends, in every one of their sockets. */
  clearTyping(fx, uid, conv, members, alreadyCleared = false) {
    if (!alreadyCleared) {
      for (const sid of this.sockets.idsOf(uid)) {
        const m = this.sockets.get(sid);
        if (m && m.typ.includes(conv)) {
          m.typ = m.typ.filter((c) => c !== conv);
          this.sockets.set(sid, m);
        }
      }
    }
    this.relayTyping(fx, uid, conv, "off", members);
  }
  membersOf(conv) {
    const pair = parseDm(conv);
    return pair ? [pair[0], pair[1]] : this.store.currentMembers(conv);
  }
  onRead(fx, id, meta, f) {
    const uid = meta.uid;
    const a = this.access(uid, f.conv);
    if (!a.ok) {
      this.deny(fx, id, uid, f.conv, a.code);
      return;
    }
    if (!a.conv)
      return;
    const before = this.store.getRead(uid, f.conv).readSeq;
    const upTo = Math.min(f.seq, a.conv.lastSeq);
    const newRead = this.store.setRead(uid, f.conv, upTo);
    if (newRead > before) {
      for (const other of this.liveSockets(uid))
        if (other !== id)
          fx.push({ kind: "send", to: other, frame: { t: "read", conv: f.conv, seq: newRead } });
    }
  }
  onPage(fx, id, meta, f, now) {
    const uid = meta.uid;
    if (this.limited(fx, id, meta, "page", now, void 0, f.conv)) {
      this.sockets.set(id, meta);
      return;
    }
    this.sockets.set(id, meta);
    const a = this.access(uid, f.conv);
    if (!a.ok) {
      this.deny(fx, id, uid, f.conv, a.code);
      return;
    }
    const limit = f.limit ?? DEFAULT_PAGE;
    const rows = a.conv ? this.store.visible(uid, f.conv, { ...f.after !== void 0 ? { after: f.after } : {}, ...f.before !== void 0 ? { before: f.before } : {}, limit: limit + 1, now }) : [];
    const more = rows.length > limit;
    const page = f.after !== void 0 ? rows.slice(0, limit) : rows.slice(rows.length - Math.min(rows.length, limit));
    fx.push({ kind: "send", to: id, frame: { t: "batch", conv: f.conv, rid: f.rid, msgs: page.map((r) => this.toMsg(r)), more } });
  }
};

// node_modules/@io-kit/chat/dist/src/server/server.js
var ChatServer = class {
  static {
    __name(this, "ChatServer");
  }
  core;
  io;
  refreshing = null;
  pushing = null;
  archiving = null;
  /** Per socket, a promise that settles when a `hello` waiting on the directory has been handled. Later frames queue behind it. */
  holds = /* @__PURE__ */ new Map();
  clock;
  constructor(core, io = {}) {
    this.core = core;
    this.io = io;
    this.clock = io.clock ?? Date.now;
  }
  /** Refresh the directory now. Single-flight. A failure keeps the old snapshot and resolves with no effects. */
  refreshDirectory(now = this.clock()) {
    const source = this.io.directory;
    if (!source)
      return Promise.resolve([]);
    if (this.refreshing)
      return this.refreshing;
    const run = source.fetch().then((members) => this.core.applyDirectory(members, now)).catch(() => []).finally(() => {
      this.refreshing = null;
    });
    this.refreshing = run;
    return run;
  }
  /**
   * Handle one inbound frame. On `hello`, a directory snapshot older than 60 s (or missing) is refreshed first; with no
   * snapshot and a failed fetch the socket closes 4503. While that fetch is pending, later frames from the same socket
   * wait for it (in arrival order), so a client that pipelines `hello` and the frames after it is not closed for sending
   * "before hello". The clock is read again after the wait, unless the caller passed `now`. Every other frame goes
   * straight to the synchronous core.
   */
  async receive(socketId, input, now) {
    const at = /* @__PURE__ */ __name(() => now ?? this.clock(), "at");
    for (let hold = this.holds.get(socketId); hold; hold = this.holds.get(socketId))
      await hold;
    const decoded = decodeClientFrame(input);
    if (decoded.ok && decoded.frame.t === "hello" && this.io.directory && this.core.directoryStale(at())) {
      let release = /* @__PURE__ */ __name(() => {
      }, "release");
      const hold = new Promise((resolve) => {
        release = resolve;
      });
      this.holds.set(socketId, hold);
      try {
        const fx = await this.refreshDirectory(at());
        const t = at();
        if (!this.core.hasDirectory())
          return [...fx, ...this.core.reject(socketId, CLOSE_CODES.disabled, t, "directory unavailable")];
        return [...fx, ...this.core.handleDecoded(socketId, decoded, t)];
      } finally {
        if (this.holds.get(socketId) === hold)
          this.holds.delete(socketId);
        release();
      }
    }
    return this.core.handleDecoded(socketId, decoded, at());
  }
  /**
   * Drain due pushes. A failure schedules the retries (1, 5, 30 minutes) and then drops the item. Single-flight: a call
   * made while a drain is in progress joins it, so no item is sent twice.
   */
  drainPush(now = this.clock()) {
    if (this.pushing)
      return this.pushing;
    const run = this.runPush(now).finally(() => {
      this.pushing = null;
    });
    this.pushing = run;
    return run;
  }
  async runPush(now) {
    const out = { sent: 0, retried: 0, dropped: 0 };
    const sink = this.io.push;
    if (!sink)
      return out;
    const items = this.core.takePush(now);
    if (items.length === 0)
      return out;
    try {
      await sink.send(items.map((p) => ({ recipient: p.recipient, conv: p.conv, seq: p.seq, actor: p.actor })));
      this.core.pushSent(items);
      out.sent = items.length;
    } catch {
      const r = this.core.pushFailed(items, now);
      out.retried = r.retried;
      out.dropped = r.dropped;
    }
    return out;
  }
  /**
   * Send rows past each conversation's cursor, in order, and move the cursor only after the sink resolves. A failed
   * batch stops the run and is retried by the next one. Single-flight: a call made while a run is in progress joins it, so
   * no batch is posted twice at once.
   */
  drainArchive(now = this.clock()) {
    if (this.archiving)
      return this.archiving;
    const run = this.runArchive(now).finally(() => {
      this.archiving = null;
    });
    this.archiving = run;
    return run;
  }
  async runArchive(now) {
    const out = { batches: 0, msgs: 0 };
    const sink = this.io.archive;
    if (!sink)
      return out;
    for (let round = 0; round < 50; round++) {
      const batches = this.core.archiveTake(now);
      const work = batches.filter((b) => b.msgs.length > 0);
      if (work.length === 0)
        break;
      for (const b of work) {
        let through;
        try {
          const res = await sink.post(b);
          through = res && typeof res.throughSeq === "number" ? res.throughSeq : b.msgs[b.msgs.length - 1]?.seq ?? 0;
        } catch {
          return out;
        }
        this.core.archiveDone(b.conv.id, Math.min(through, b.msgs[b.msgs.length - 1]?.seq ?? through));
        out.batches++;
        out.msgs += b.msgs.length;
      }
    }
    return out;
  }
  /**
   * One storage-alarm wake: timed core work, then pushes and the archive when due. Returns the effects to deliver and the
   * next wake time for `setAlarm`.
   */
  async alarm(now = this.clock()) {
    const effects = this.core.tick(now);
    await this.drainPush(now);
    if (this.core.archiveDue(now))
      await this.drainArchive(now);
    return { effects, next: this.core.nextWake(now) };
  }
};

// node_modules/@io-kit/chat/dist/src/server/sql-store.js
var SCHEMA = [
  "CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS conv (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('dm','group')),
    name TEXT,
    creator TEXT NOT NULL,
    policy TEXT CHECK (policy IN ('private','open')),
    created_at INTEGER NOT NULL,
    created_cmid TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_ts INTEGER NOT NULL,
    last_msg_seq INTEGER,
    last_msg_from TEXT
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS conv_created ON conv(creator, created_cmid)",
  `CREATE TABLE IF NOT EXISTS member (
    conv TEXT NOT NULL,
    uid TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    join_seq INTEGER NOT NULL,
    left_seq INTEGER,
    invited_by TEXT,
    PRIMARY KEY (conv, uid, epoch)
  )`,
  "CREATE INDEX IF NOT EXISTS member_uid ON member(uid, left_seq)",
  `CREATE TABLE IF NOT EXISTS msg (
    conv TEXT NOT NULL,
    seq INTEGER NOT NULL,
    cmid TEXT NOT NULL,
    from_uid TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('msg','sys')),
    text TEXT,
    sys TEXT,
    ts INTEGER NOT NULL,
    PRIMARY KEY (conv, seq)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS msg_cmid ON msg(conv, from_uid, cmid)",
  "CREATE INDEX IF NOT EXISTS msg_ts ON msg(conv, ts)",
  `CREATE TABLE IF NOT EXISTS readpos (
    uid TEXT NOT NULL,
    conv TEXT NOT NULL,
    read_seq INTEGER NOT NULL DEFAULT 0,
    notified_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (uid, conv)
  )`,
  `CREATE TABLE IF NOT EXISTS presence (
    uid TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('active','idle','offline')),
    since INTEGER NOT NULL,
    grace_until INTEGER
  )`,
  "CREATE TABLE IF NOT EXISTS directory (uid TEXT PRIMARY KEY, label TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS push_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    actor TEXT NOT NULL,
    conv TEXT NOT NULL,
    seq INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL
  )`,
  "CREATE TABLE IF NOT EXISTS archive_cursor (conv TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0)",
  "INSERT INTO schema_version (v) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version)"
];
var MSG_COLS = "m.conv, m.seq, m.cmid, m.from_uid, m.kind, m.text, m.sys, m.ts";
var VISIBLE_FROM = "FROM msg m JOIN member e ON e.conv = m.conv AND e.uid = ? WHERE m.conv = ? AND m.seq >= e.join_seq AND (e.left_seq IS NULL OR m.seq <= e.left_seq) AND m.ts >= ?";
var num = /* @__PURE__ */ __name((v) => Number(v), "num");
var numOrNull = /* @__PURE__ */ __name((v) => v === null || v === void 0 ? null : Number(v), "numOrNull");
var strOrNull = /* @__PURE__ */ __name((v) => v === null || v === void 0 ? null : String(v), "strOrNull");
function convOf(r) {
  return {
    id: String(r.id),
    kind: r.kind === "dm" ? "dm" : "group",
    name: strOrNull(r.name),
    creator: String(r.creator),
    policy: r.policy === "private" || r.policy === "open" ? r.policy : null,
    createdAt: num(r.created_at),
    createdCmid: String(r.created_cmid),
    lastSeq: num(r.last_seq),
    lastTs: num(r.last_ts),
    lastMsgSeq: numOrNull(r.last_msg_seq),
    lastMsgFrom: strOrNull(r.last_msg_from)
  };
}
__name(convOf, "convOf");
function epochOf(r) {
  return {
    conv: String(r.conv),
    uid: String(r.uid),
    epoch: num(r.epoch),
    joinSeq: num(r.join_seq),
    leftSeq: numOrNull(r.left_seq),
    invitedBy: strOrNull(r.invited_by)
  };
}
__name(epochOf, "epochOf");
function msgOf(r) {
  const kind = r.kind === "sys" ? "sys" : "msg";
  return {
    conv: String(r.conv),
    seq: num(r.seq),
    cmid: String(r.cmid),
    from: String(r.from_uid),
    kind,
    text: kind === "msg" ? String(r.text ?? "") : null,
    sys: kind === "sys" && typeof r.sys === "string" ? JSON.parse(r.sys) : null,
    ts: num(r.ts)
  };
}
__name(msgOf, "msgOf");
var SqlStore = class {
  static {
    __name(this, "SqlStore");
  }
  db;
  constructor(db) {
    this.db = db;
    for (const stmt of SCHEMA)
      this.rows(stmt);
  }
  rows(sql, ...b) {
    return this.db.exec(sql, ...b).toArray();
  }
  one(sql, ...b) {
    return this.rows(sql, ...b)[0];
  }
  getConv(id) {
    const r = this.one("SELECT * FROM conv WHERE id = ?", id);
    return r ? convOf(r) : null;
  }
  convByCreated(creator, cmid) {
    const r = this.one("SELECT * FROM conv WHERE creator = ? AND created_cmid = ?", creator, cmid);
    return r ? convOf(r) : null;
  }
  currentMembers(conv) {
    return this.rows("SELECT DISTINCT uid FROM member WHERE conv = ? AND left_seq IS NULL ORDER BY uid", conv).map((r) => String(r.uid));
  }
  epochsOf(conv, uid) {
    return this.rows("SELECT * FROM member WHERE conv = ? AND uid = ? ORDER BY epoch", conv, uid).map(epochOf);
  }
  convsOf(uid) {
    return this.rows("SELECT c.* FROM conv c WHERE c.id IN (SELECT conv FROM member WHERE uid = ? AND left_seq IS NULL) ORDER BY c.last_ts DESC, c.id", uid).map(convOf);
  }
  ackFor(conv, from, cmid) {
    const r = this.one("SELECT seq, ts FROM msg WHERE conv = ? AND from_uid = ? AND cmid = ?", conv, from, cmid);
    return r ? { seq: num(r.seq), ts: num(r.ts) } : null;
  }
  append(convId, draft, guard) {
    return this.db.transactionSync(() => {
      const existingRow = this.one("SELECT * FROM conv WHERE id = ?", convId);
      const existing = existingRow ? convOf(existingRow) : null;
      if (guard.create) {
        if (existing)
          return { ok: false, reason: "conv_exists" };
        const dup = this.one("SELECT id, created_at FROM conv WHERE creator = ? AND created_cmid = ?", guard.create.creator, guard.create.createdCmid);
        if (dup)
          return { ok: false, reason: "duplicate", conv: String(dup.id), ack: { seq: 1, ts: num(dup.created_at) } };
      } else if (!existing) {
        return { ok: false, reason: "no_conv" };
      }
      const dupMsg = existing ? this.ackFor(convId, draft.from, draft.cmid) : null;
      if (dupMsg)
        return { ok: false, reason: "duplicate", conv: convId, ack: dupMsg };
      const nc = guard.create;
      const base = existing ?? {
        id: convId,
        kind: nc?.kind ?? "group",
        name: nc?.name ?? null,
        creator: nc?.creator ?? draft.from,
        policy: nc?.policy ?? null,
        createdAt: nc?.createdAt ?? draft.ts,
        createdCmid: nc?.createdCmid ?? draft.cmid,
        lastSeq: 0,
        lastTs: draft.ts,
        lastMsgSeq: null,
        lastMsgFrom: null
      };
      if (guard.pacing && draft.kind === "msg" && !guard.pacing.peerOnline && base.lastMsgFrom === guard.pacing.sender) {
        return { ok: false, reason: "pace_wait" };
      }
      const seq = base.lastSeq + 1;
      const conv = { ...base, lastSeq: seq, lastTs: draft.ts };
      if (draft.kind === "msg") {
        conv.lastMsgSeq = seq;
        conv.lastMsgFrom = draft.from;
      }
      if (guard.patch?.name !== void 0)
        conv.name = guard.patch.name;
      if (guard.patch?.policy !== void 0)
        conv.policy = guard.patch.policy;
      if (!existing) {
        this.rows("INSERT INTO conv (id, kind, name, creator, policy, created_at, created_cmid, last_seq, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)", conv.id, conv.kind, conv.name, conv.creator, conv.policy, conv.createdAt, conv.createdCmid, conv.lastTs);
      }
      const row = {
        conv: convId,
        seq,
        cmid: draft.cmid,
        from: draft.from,
        kind: draft.kind,
        text: draft.kind === "msg" ? draft.text ?? "" : null,
        sys: draft.kind === "sys" && draft.sys ? draft.sys : null,
        ts: draft.ts
      };
      this.rows("INSERT INTO msg (conv, seq, cmid, from_uid, kind, text, sys, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row.conv, row.seq, row.cmid, row.from, row.kind, row.text, row.sys ? JSON.stringify(row.sys) : null, row.ts);
      for (const uid of guard.membership?.close ?? []) {
        this.rows("UPDATE member SET left_seq = ? WHERE conv = ? AND uid = ? AND left_seq IS NULL", seq, convId, uid);
      }
      for (const o of guard.membership?.open ?? []) {
        const max = this.one("SELECT COALESCE(MAX(epoch), 0) AS n FROM member WHERE conv = ? AND uid = ?", convId, o.uid);
        this.rows("INSERT INTO member (conv, uid, epoch, join_seq, left_seq, invited_by) VALUES (?, ?, ?, ?, NULL, ?)", convId, o.uid, num(max?.n) + 1, seq, o.invitedBy);
      }
      this.rows("UPDATE conv SET last_seq = ?, last_ts = ?, last_msg_seq = ?, last_msg_from = ?, name = ?, policy = ? WHERE id = ?", conv.lastSeq, conv.lastTs, conv.lastMsgSeq, conv.lastMsgFrom, conv.name, conv.policy, convId);
      return { ok: true, row, conv };
    });
  }
  visible(uid, conv, q) {
    const cutoff = q.now - VISIBILITY_MS;
    if (q.after !== void 0) {
      return this.rows(`SELECT ${MSG_COLS} ${VISIBLE_FROM} AND m.seq > ? ORDER BY m.seq LIMIT ?`, uid, conv, cutoff, q.after, q.limit).map(msgOf);
    }
    const rows = q.before !== void 0 ? this.rows(`SELECT ${MSG_COLS} ${VISIBLE_FROM} AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`, uid, conv, cutoff, q.before, q.limit) : this.rows(`SELECT ${MSG_COLS} ${VISIBLE_FROM} ORDER BY m.seq DESC LIMIT ?`, uid, conv, cutoff, q.limit);
    return rows.map(msgOf).reverse();
  }
  /** The SQLite query plan of the visibility query (conformance case CH-30 reads it). */
  visiblePlan() {
    return this.rows(`EXPLAIN QUERY PLAN SELECT ${MSG_COLS} ${VISIBLE_FROM} AND m.seq > ? ORDER BY m.seq LIMIT ?`, "u", "c", 0, 0, 1).map((r) => String(r.detail));
  }
  getRead(uid, conv) {
    const r = this.one("SELECT read_seq, notified_seq FROM readpos WHERE uid = ? AND conv = ?", uid, conv);
    return r ? { readSeq: num(r.read_seq), notifiedSeq: num(r.notified_seq) } : { readSeq: 0, notifiedSeq: 0 };
  }
  setRead(uid, conv, seq) {
    return this.db.transactionSync(() => {
      this.rows("INSERT INTO readpos (uid, conv, read_seq, notified_seq) VALUES (?, ?, ?, 0) ON CONFLICT(uid, conv) DO UPDATE SET read_seq = MAX(read_seq, excluded.read_seq)", uid, conv, seq);
      return this.getRead(uid, conv).readSeq;
    });
  }
  getPresence(uid) {
    const r = this.one("SELECT * FROM presence WHERE uid = ?", uid);
    return r ? presenceOf(r) : null;
  }
  putPresence(row) {
    this.rows("INSERT INTO presence (uid, state, since, grace_until) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET state = excluded.state, since = excluded.since, grace_until = excluded.grace_until", row.uid, row.state, row.since, row.graceUntil);
  }
  deletePresence(uid) {
    this.rows("DELETE FROM presence WHERE uid = ?", uid);
  }
  allPresence() {
    return this.rows("SELECT * FROM presence ORDER BY uid").map(presenceOf);
  }
  directory() {
    return this.rows("SELECT uid, label FROM directory ORDER BY uid").map((r) => ({ id: String(r.uid), label: String(r.label) }));
  }
  directoryAt() {
    const v = this.getKv("directory_at");
    return v === null ? null : Number(v);
  }
  replaceDirectory(members, at) {
    this.db.transactionSync(() => {
      this.rows("DELETE FROM directory");
      for (const m of members)
        this.rows("INSERT OR REPLACE INTO directory (uid, label) VALUES (?, ?)", m.id, m.label);
      this.setKv("directory_at", String(at));
    });
  }
  armPush(recipient, actor, conv, seq, now) {
    return this.db.transactionSync(() => {
      const cur = this.getRead(recipient, conv);
      if (cur.notifiedSeq > cur.readSeq)
        return false;
      this.rows("INSERT INTO readpos (uid, conv, read_seq, notified_seq) VALUES (?, ?, 0, ?) ON CONFLICT(uid, conv) DO UPDATE SET notified_seq = excluded.notified_seq", recipient, conv, seq);
      this.rows("INSERT INTO push_outbox (uid, actor, conv, seq, attempts, next_at) VALUES (?, ?, ?, ?, 0, ?)", recipient, actor, conv, seq, now);
      return true;
    });
  }
  pushDue(now, limit) {
    return this.rows("SELECT * FROM push_outbox WHERE next_at <= ? ORDER BY id LIMIT ?", now, limit).map((r) => ({
      id: num(r.id),
      recipient: String(r.uid),
      actor: String(r.actor),
      conv: String(r.conv),
      seq: num(r.seq),
      attempts: num(r.attempts),
      nextAt: num(r.next_at)
    }));
  }
  pushNextAt() {
    return numOrNull(this.one("SELECT MIN(next_at) AS n FROM push_outbox")?.n);
  }
  pushDelete(ids) {
    for (const id of ids)
      this.rows("DELETE FROM push_outbox WHERE id = ?", id);
  }
  pushRetry(id, attempts, nextAt) {
    this.rows("UPDATE push_outbox SET attempts = ?, next_at = ? WHERE id = ?", attempts, nextAt, id);
  }
  pushDropFor(uid) {
    this.rows("DELETE FROM push_outbox WHERE uid = ?", uid);
  }
  archiveBatches(maxMsgs, maxConvs) {
    const convs = this.rows("SELECT c.* FROM conv c LEFT JOIN archive_cursor a ON a.conv = c.id WHERE c.last_seq > COALESCE(a.seq, 0) ORDER BY c.id LIMIT ?", maxConvs).map(convOf);
    return convs.map((conv) => ({
      conv,
      members: this.rows("SELECT * FROM member WHERE conv = ? ORDER BY uid, epoch", conv.id).map(epochOf),
      // The archive mirror reads rows past its cursor, with no 30-day bound: retention is indefinite (R-35). It is not a user path.
      msgs: this.rows(`SELECT ${MSG_COLS} FROM msg m WHERE m.conv = ? AND m.seq > COALESCE((SELECT seq FROM archive_cursor WHERE conv = ?), 0) ORDER BY m.seq LIMIT ?`, conv.id, conv.id, maxMsgs).map(msgOf)
    }));
  }
  archiveAdvance(conv, seq) {
    this.rows("INSERT INTO archive_cursor (conv, seq) VALUES (?, ?) ON CONFLICT(conv) DO UPDATE SET seq = MAX(seq, excluded.seq)", conv, seq);
  }
  archiveHasPending() {
    return this.one("SELECT 1 AS x FROM conv c LEFT JOIN archive_cursor a ON a.conv = c.id WHERE c.last_seq > COALESCE(a.seq, 0) LIMIT 1") !== void 0;
  }
  getKv(key) {
    const r = this.one("SELECT v FROM kv WHERE k = ?", key);
    return r ? String(r.v) : null;
  }
  setKv(key, value) {
    this.rows("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
  }
};
function presenceOf(r) {
  return {
    uid: String(r.uid),
    state: r.state === "active" || r.state === "idle" ? r.state : "offline",
    since: num(r.since),
    graceUntil: numOrNull(r.grace_until)
  };
}
__name(presenceOf, "presenceOf");

// node_modules/@io-kit/chat/dist/src/cloudflare/socket-table.js
var ATTACHMENT_SOFT_BYTES = 12288;
var encoder2 = new TextEncoder();
function attachmentBytes(att) {
  return encoder2.encode(JSON.stringify(att)).length;
}
__name(attachmentBytes, "attachmentBytes");
function fit(att) {
  const m = att.m;
  if (!m || attachmentBytes(att) <= ATTACHMENT_SOFT_BYTES)
    return;
  m.tb.tt = {};
  if (attachmentBytes(att) <= ATTACHMENT_SOFT_BYTES)
    return;
  m.typ = m.typ.slice(-16);
}
__name(fit, "fit");
function read(ws) {
  const v = ws.deserializeAttachment();
  return v && typeof v === "object" && typeof v.id === "string" ? v : null;
}
__name(read, "read");
var AttachmentSocketTable = class {
  static {
    __name(this, "AttachmentSocketTable");
  }
  ctx;
  view = /* @__PURE__ */ new Map();
  all = false;
  tags = /* @__PURE__ */ new Set();
  constructor(ctx) {
    this.ctx = ctx;
  }
  /** Events in flight (handlers overlap whenever one of them awaits). */
  depth = 0;
  /** Forget the view unconditionally. Prefer `enter()`/`leave()`, which never drop the view under an event in flight. */
  reset() {
    this.view = /* @__PURE__ */ new Map();
    this.all = false;
    this.tags.clear();
  }
  /** An event begins. The first of a set of overlapping events starts from a fresh view. */
  enter() {
    if (this.depth === 0)
      this.reset();
    this.depth++;
  }
  /** An event ends. The view is dropped only when the last overlapping event has left. */
  leave() {
    if (this.depth > 0)
      this.depth--;
    if (this.depth === 0)
      this.reset();
  }
  /** Events currently in flight (for tests). */
  get inFlight() {
    return this.depth;
  }
  load(ws) {
    const att = read(ws);
    if (!att)
      return null;
    let e = this.view.get(att.id);
    if (!e) {
      e = { ws, att };
      this.view.set(att.id, e);
    }
    return e;
  }
  scanAll() {
    if (this.all)
      return;
    for (const ws of this.ctx.getWebSockets())
      this.load(ws);
    this.all = true;
  }
  /** Put a socket the event is about into the view without scanning the others. */
  adopt(ws) {
    return this.load(ws)?.att.id ?? null;
  }
  /** The socket object for an id (any socket, whether or not the core still tracks it). One scan when it is not in the view. */
  socket(id) {
    let e = this.view.get(id);
    if (!e) {
      this.scanAll();
      e = this.view.get(id);
    }
    return e?.ws;
  }
  /** The sockets for a batch of ids with a single scan. */
  sockets(ids) {
    const out = /* @__PURE__ */ new Map();
    for (const id of ids) {
      if (out.has(id))
        continue;
      const ws = this.socket(id);
      if (ws)
        out.set(id, ws);
    }
    return out;
  }
  /** Last inbound traffic time recorded in the attachment. */
  lastTraffic(id) {
    this.socket(id);
    return this.view.get(id)?.att.ls ?? null;
  }
  /** Record inbound traffic; the attachment is rewritten at most every 5 s per socket. */
  touch(id, now) {
    const e = this.view.get(id);
    if (!e)
      return;
    if (e.att.ls !== void 0 && now - e.att.ls < 5e3)
      return;
    e.att = { ...e.att, ls: now };
    fit(e.att);
    e.ws.serializeAttachment(e.att);
  }
  /** Stamp a freshly accepted socket with its id (no meta yet). */
  stamp(ws, id, now) {
    const att = { id, ls: now };
    ws.serializeAttachment(att);
    this.view.set(id, { ws, att });
  }
  // ---- SocketTable
  get(id) {
    this.socket(id);
    return this.view.get(id)?.att.m;
  }
  set(id, meta) {
    this.socket(id);
    const e = this.view.get(id);
    if (!e)
      return;
    e.att = { ...e.att, m: meta };
    fit(e.att);
    e.ws.serializeAttachment(e.att);
  }
  delete(id) {
    this.socket(id);
    const e = this.view.get(id);
    if (!e || !e.att.m)
      return;
    e.att = e.att.ls !== void 0 ? { id, ls: e.att.ls } : { id };
    e.ws.serializeAttachment(e.att);
  }
  ids() {
    this.scanAll();
    return [...this.view.values()].filter((e) => e.att.m).map((e) => e.att.id).sort();
  }
  idsOf(uid) {
    if (!this.tags.has(uid) && !this.all) {
      for (const ws of this.ctx.getWebSockets(uid))
        this.load(ws);
      this.tags.add(uid);
    }
    return [...this.view.values()].filter((e) => e.att.m?.uid === uid).map((e) => e.att.id).sort();
  }
};

// node_modules/@io-kit/chat/dist/src/cloudflare/session.js
var DEFAULT_SESSION_CONFIG = {
  cookie: "io_id",
  skewSeconds: 60,
  jwksTtlSeconds: 300,
  minRefetchSeconds: 30,
  failureBackoffSeconds: 2,
  fetchTimeoutMs: 3e3,
  subPattern: /^[A-Za-z0-9_-]{1,64}$/
};
var MAX_TOKEN_CHARS = 8192;
var encoder3 = new TextEncoder();
var decoder = new TextDecoder();
function fromB64u(s) {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b + "=".repeat((4 - b.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
__name(fromB64u, "fromB64u");
function toB64u(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 32768)
    bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(toB64u, "toB64u");
var RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
function cookieValue(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return null;
}
__name(cookieValue, "cookieValue");
function createSessionVerifier(config, deps = {}) {
  for (const k of ["issuer", "audience", "jwksUrl"]) {
    if (typeof config[k] !== "string" || !config[k])
      throw new Error(`session config: ${k} is required`);
  }
  const cfg = {
    cookie: config.cookie ?? DEFAULT_SESSION_CONFIG.cookie,
    skewSeconds: config.skewSeconds ?? DEFAULT_SESSION_CONFIG.skewSeconds,
    jwksTtlSeconds: config.jwksTtlSeconds ?? DEFAULT_SESSION_CONFIG.jwksTtlSeconds,
    minRefetchSeconds: config.minRefetchSeconds ?? DEFAULT_SESSION_CONFIG.minRefetchSeconds,
    failureBackoffSeconds: config.failureBackoffSeconds ?? DEFAULT_SESSION_CONFIG.failureBackoffSeconds,
    fetchTimeoutMs: config.fetchTimeoutMs ?? DEFAULT_SESSION_CONFIG.fetchTimeoutMs,
    subPattern: config.subPattern ?? DEFAULT_SESSION_CONFIG.subPattern
  };
  const fetchImpl = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {
  });
  let keys = /* @__PURE__ */ new Map();
  let fetchedAt = 0;
  let lastAttemptAt = null;
  let lastAttemptFailed = false;
  let inflight = null;
  function refresh() {
    if (inflight)
      return inflight;
    const run = (async () => {
      let ok = false;
      try {
        const res = await fetchImpl(config.jwksUrl, { signal: AbortSignal.timeout(cfg.fetchTimeoutMs), headers: { accept: "application/json" } });
        if (!res.ok)
          throw new Error(`jwks http ${res.status}`);
        const body = await res.json();
        const next = /* @__PURE__ */ new Map();
        for (const raw of Array.isArray(body?.keys) ? body.keys : []) {
          const jwk = raw;
          if (!jwk || jwk.kty !== "RSA" || typeof jwk.kid !== "string" || jwk.use && jwk.use !== "sig" || jwk.alg && jwk.alg !== "RS256")
            continue;
          if (typeof jwk.n !== "string" || typeof jwk.e !== "string")
            continue;
          try {
            next.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, RS256, false, ["verify"]));
          } catch {
          }
        }
        if (next.size > 0) {
          keys = next;
          fetchedAt = now();
          ok = true;
        } else
          log("chat session: jwks had no usable RS256 keys");
      } catch (e) {
        log(`chat session: jwks refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        lastAttemptAt = now();
        lastAttemptFailed = !ok;
        inflight = null;
      }
    })();
    inflight = run;
    return run;
  }
  __name(refresh, "refresh");
  async function keyFor(kid) {
    const t = now();
    const fresh = keys.size > 0 && t - fetchedAt < cfg.jwksTtlSeconds * 1e3;
    const hit = keys.get(kid);
    if (fresh && hit)
      return hit;
    const waitMs = (lastAttemptFailed ? cfg.failureBackoffSeconds : cfg.minRefetchSeconds) * 1e3;
    const cooling = lastAttemptAt !== null && t - lastAttemptAt < waitMs;
    if (inflight)
      await inflight;
    else if (!cooling)
      await refresh();
    return keys.get(kid) ?? null;
  }
  __name(keyFor, "keyFor");
  function parseJson(b64u) {
    return JSON.parse(decoder.decode(fromB64u(b64u)));
  }
  __name(parseJson, "parseJson");
  async function verifyToken(token) {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS)
      return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p2) => !/^[A-Za-z0-9_-]+$/.test(p2)))
      return { ok: false, reason: "malformed" };
    const [h, p, s] = parts;
    let header;
    let claims;
    try {
      header = parseJson(h);
      claims = parseJson(p);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    const hd = header;
    if (!hd || typeof hd !== "object" || hd.alg !== "RS256" || typeof hd.kid !== "string")
      return { ok: false, reason: "alg-or-kid" };
    const key = await keyFor(hd.kid);
    if (!key)
      return { ok: false, reason: keys.size === 0 ? "jwks-unavailable" : "unknown-kid" };
    let good;
    try {
      good = await crypto.subtle.verify(RS256, key, fromB64u(s), encoder3.encode(`${h}.${p}`));
    } catch {
      good = false;
    }
    if (!good)
      return { ok: false, reason: "bad-signature" };
    if (!claims || typeof claims !== "object" || Array.isArray(claims))
      return { ok: false, reason: "malformed" };
    const c = claims;
    if (c.iss !== config.issuer)
      return { ok: false, reason: "iss" };
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(config.audience))
      return { ok: false, reason: "aud" };
    const nowS = Math.floor(now() / 1e3);
    if (typeof c.exp !== "number" || nowS > c.exp + cfg.skewSeconds)
      return { ok: false, reason: "expired" };
    if (c.nbf !== void 0 && (typeof c.nbf !== "number" || nowS + cfg.skewSeconds < c.nbf))
      return { ok: false, reason: "nbf" };
    if (typeof c.sub !== "string" || !cfg.subPattern.test(c.sub))
      return { ok: false, reason: "sub" };
    return { ok: true, claims: c };
  }
  __name(verifyToken, "verifyToken");
  async function verifyCookie(cookieHeader) {
    const token = cookieValue(cookieHeader, cfg.cookie);
    if (!token)
      return { ok: false, reason: "no-cookie" };
    try {
      return await verifyToken(token);
    } catch (e) {
      log(`chat session: deny error ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, reason: "malformed" };
    }
  }
  __name(verifyCookie, "verifyCookie");
  return { verifyToken, verifyCookie };
}
__name(createSessionVerifier, "createSessionVerifier");
var SERVICE_TOKEN = { iss: "hfy-chat", aud: "hfy-api/chat", sub: "chat-hub", ttlSeconds: 60, defaultKid: "hfy-chat-1" };
var cached = null;
async function importServiceKey(secret) {
  const digest2 = toB64u(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder3.encode(secret))));
  if (cached?.digest === digest2)
    return cached.key;
  const body = secret.replace(/-----(BEGIN|END)[A-Z ]*-----/g, "").replace(/\s+/g, "");
  const key = crypto.subtle.importKey("pkcs8", fromB64u(body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const entry = { digest: digest2, key };
  cached = entry;
  key.catch(() => {
    if (cached === entry)
      cached = null;
  });
  return key;
}
__name(importServiceKey, "importServiceKey");
async function signServiceToken(privateKey, options = {}) {
  const key = await importServiceKey(privateKey);
  const t = options.now ?? Date.now();
  const iat = Math.floor(t / 1e3);
  const ttl = Math.min(options.ttlSeconds ?? SERVICE_TOKEN.ttlSeconds, SERVICE_TOKEN.ttlSeconds);
  const header = { alg: "ES256", kid: options.kid ?? SERVICE_TOKEN.defaultKid, typ: "JWT" };
  const claims = { iss: SERVICE_TOKEN.iss, aud: SERVICE_TOKEN.aud, sub: SERVICE_TOKEN.sub, iat, exp: iat + ttl, jti: options.jti ?? newUlid(t) };
  const signing = `${toB64u(encoder3.encode(JSON.stringify(header)))}.${toB64u(encoder3.encode(JSON.stringify(claims)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder3.encode(signing)));
  return `${signing}.${toB64u(sig)}`;
}
__name(signServiceToken, "signServiceToken");

// node_modules/@io-kit/chat/dist/src/cloudflare/hub.js
var AUTO_PING = '{"t":"ping"}';
var AUTO_PONG = '{"t":"pong"}';
var HUB_NAME = "family";
var HUB_LOCATION_HINT = "wnam";
var UID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var API_TIMEOUT_MS = 1e4;
var INTERNAL_ERROR_CLOSE = 4500;
var LABEL_MAX = 80;
var CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
function cleanLabel(label2, fallback) {
  const t = Array.from(label2.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim()).slice(0, LABEL_MAX).join("").trim();
  return t || fallback;
}
__name(cleanLabel, "cleanLabel");
function errorName(e) {
  const n = e instanceof Error ? e.name : typeof e;
  return /^[A-Za-z0-9_]{1,40}$/.test(n) ? n : "Error";
}
__name(errorName, "errorName");
var json = /* @__PURE__ */ __name((status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }), "json");
var list = /* @__PURE__ */ __name((s) => s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [], "list");
function echoCode(code) {
  return typeof code === "number" && code >= 3e3 && code <= 4999 ? code : CLOSE_CODES.normal;
}
__name(echoCode, "echoCode");
var ChatHub = class {
  static {
    __name(this, "ChatHub");
  }
  ctx;
  env;
  options;
  /** The server core, exposed for hosts that wrap the object. */
  core;
  server;
  /** The hub's SQLite store (`SqlStore` over `ctx.storage.sql`). */
  store;
  table;
  now;
  ready;
  constructor(ctx, env = {}, options = {}) {
    this.ctx = ctx;
    this.env = env;
    this.options = options;
    this.now = options.clock ?? (() => Date.now());
    const sql = ctx.storage;
    const driver = {
      exec: /* @__PURE__ */ __name((q, ...b) => sql.sql.exec(q, ...b), "exec"),
      transactionSync: /* @__PURE__ */ __name((fn) => sql.transactionSync(fn), "transactionSync")
    };
    const store = new SqlStore(driver);
    this.store = store;
    this.table = new AttachmentSocketTable(ctx);
    const core = {
      store,
      sockets: this.table,
      openTo: env.CHAT_OPEN_TO === "all" ? "all" : "uat",
      uatSubjects: list(env.CHAT_UAT_SUBJECTS),
      log: options.log ?? defaultLog,
      ...options.contactGuard ? { contactGuard: options.contactGuard } : {},
      ...options.mediaHosts ? { mediaHosts: options.mediaHosts } : {},
      ...options.allowPolicyChange !== void 0 ? { allowPolicyChange: options.allowPolicyChange } : {}
    };
    this.core = new ChatCore(core);
    this.server = new ChatServer(this.core, this.io());
    const make = options.autoResponse ?? ((req, res) => {
      const Pair = globalThis.WebSocketRequestResponsePair;
      return Pair ? new Pair(req, res) : void 0;
    });
    const pair = make(AUTO_PING, AUTO_PONG);
    if (pair !== void 0)
      ctx.setWebSocketAutoResponse(pair);
    const init = /* @__PURE__ */ __name(async () => {
      this.table.enter();
      try {
        this.deliver(this.core.recover(this.now()));
        await this.reschedule();
      } finally {
        this.table.leave();
      }
    }, "init");
    this.ready = ctx.blockConcurrencyWhile ? ctx.blockConcurrencyWhile(init) : init();
  }
  // ---------------------------------------------------------------- the Durable Object surface
  /** The Worker forwards an accepted upgrade here with `x-chat-uid` and `x-chat-exp` (never the cookie). */
  async fetch(request) {
    await this.ready;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return json(426, { error: "upgrade_required" });
    const uid = request.headers.get("x-chat-uid") ?? "";
    const expRaw = request.headers.get("x-chat-exp") ?? "";
    if (!UID_RE.test(uid) || !/^\d{1,12}$/.test(expRaw))
      return json(400, { error: "bad_request" });
    this.table.enter();
    let client;
    let server;
    try {
      const now = this.now();
      [client, server] = this.pair();
      const id = this.nextSocketId();
      this.ctx.acceptWebSocket(server, [uid]);
      this.table.stamp(server, id, now);
      this.deliver(this.core.connect(id, { uid, exp: Number(expRaw) }, now));
      await this.reschedule();
    } catch (e) {
      this.log("chat.error", { where: "connect", name: errorName(e) });
      if (!client || !server)
        return json(500, { error: "internal" });
      try {
        server.close(INTERNAL_ERROR_CLOSE, "internal");
      } catch {
      }
    } finally {
      this.table.leave();
    }
    if (!client)
      return json(500, { error: "internal" });
    return this.options.upgrade ? this.options.upgrade(client) : upgradeResponse(client);
  }
  async webSocketMessage(ws, message) {
    await this.event("message", ws, async () => {
      const id = this.table.adopt(ws);
      if (!id) {
        ws.close(CLOSE_CODES.unauthenticated, "unknown socket");
        return;
      }
      const now = this.now();
      this.table.touch(id, now);
      let input = message;
      if (typeof message !== "string") {
        if (message.byteLength > LIMITS.frameBytes) {
          this.deliver(this.core.reject(id, CLOSE_CODES.frameTooBig, now, "frame too big"));
          return;
        }
        input = "\0";
      }
      this.deliver(await this.server.receive(id, input));
    });
  }
  async webSocketClose(ws, code) {
    await this.event("close", void 0, async () => {
      this.gone(ws);
      try {
        ws.close(echoCode(code), "");
      } catch {
      }
    });
  }
  async webSocketError(ws) {
    await this.event("error", void 0, async () => {
      this.gone(ws);
    });
  }
  /**
   * The one storage alarm: liveness sweep, timed core work, then the push and archive drains. Each phase has its own guard,
   * so a failing sweep never starves the push outbox or the archive drain.
   */
  async alarm() {
    await this.event("alarm", void 0, async () => {
      const now = this.now();
      await this.phase("sweep", () => this.deliver([...this.core.sweepLiveness(now, (id) => this.lastSeen(id)), ...this.core.tick(now)]));
      await this.phase("push", async () => void await this.server.drainPush(now));
      await this.phase("archive", async () => {
        if (this.core.archiveDue(now))
          await this.server.drainArchive(now);
      });
    });
  }
  // ---------------------------------------------------------------- internals
  log(event, fields) {
    (this.options.log ?? defaultLog)(event, fields);
  }
  /** Run one alarm phase; a failure is logged (class name only) and does not stop the next phase. */
  async phase(name, fn) {
    try {
      await fn();
    } catch (e) {
      this.log("chat.error", { where: "alarm", phase: name, name: errorName(e) });
    }
  }
  /**
   * One event: wait for the cold start, hold the table's view for as long as any event is in flight (events overlap whenever
   * one awaits), run, reschedule the alarm. A handler that throws is logged by class name and, when it was a socket's own
   * message, that socket is closed so the client reconnects instead of waiting on a frame that will never be answered.
   */
  async event(where, ws, fn) {
    await this.ready;
    this.table.enter();
    try {
      await fn();
    } catch (e) {
      this.log("chat.error", { where, name: errorName(e) });
      if (ws) {
        try {
          ws.close(INTERNAL_ERROR_CLOSE, "internal");
        } catch {
        }
      }
    } finally {
      this.table.leave();
    }
    try {
      await this.reschedule();
    } catch (e) {
      this.log("chat.error", { where: "reschedule", name: errorName(e) });
    }
  }
  /**
   * A socket id that sorts in connection order: a counter kept in SQLite, so it survives eviction. The core closes the
   * "oldest" socket beyond the cap by this order when connect times tie.
   */
  nextSocketId() {
    const n = Number(this.store.getKv("sock_seq") ?? 0) + 1;
    this.store.setKv("sock_seq", String(n));
    return `s${String(n).padStart(12, "0")}`;
  }
  gone(ws) {
    const id = this.table.adopt(ws);
    if (id)
      this.deliver(this.core.disconnect(id, this.now()));
  }
  pair() {
    if (this.options.webSocketPair)
      return this.options.webSocketPair();
    const Pair = globalThis.WebSocketPair;
    if (!Pair)
      throw new Error("WebSocketPair is not available in this runtime");
    const p = new Pair();
    return [p[0], p[1]];
  }
  /** Last sign of life from a socket: its latest ordinary frame or its latest auto-responded ping. */
  lastSeen(id) {
    const ws = this.table.socket(id);
    const auto = ws ? this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() : void 0;
    const t = Math.max(this.table.lastTraffic(id) ?? 0, auto ?? 0);
    return t > 0 ? t : null;
  }
  /** Perform the core's effects. One scan finds every target socket. */
  deliver(fx) {
    if (fx.length === 0)
      return;
    const socks = this.table.sockets(fx.map((e) => e.to));
    const text = /* @__PURE__ */ new Map();
    for (const e of fx) {
      const ws = socks.get(e.to);
      if (!ws)
        continue;
      try {
        if (e.kind === "send") {
          let s = text.get(e.frame);
          if (s === void 0) {
            s = JSON.stringify(e.frame);
            text.set(e.frame, s);
          }
          ws.send(s);
        } else {
          ws.close(e.code, e.reason ? e.reason.slice(0, 100) : void 0);
        }
      } catch {
      }
    }
  }
  /** Point the single storage alarm at the core's next wake. Writes only when the alarm must move earlier. */
  async reschedule() {
    const store = this.ctx.storage;
    const next = this.core.nextWake(this.now());
    const cur = await store.getAlarm();
    if (next === null) {
      if (cur !== null)
        await store.deleteAlarm();
    } else if (cur === null || cur > next) {
      await store.setAlarm(next);
    }
  }
  // ---------------------------------------------------------------- the API (directory, push, archive)
  io() {
    const base = (this.env.API_BASE ?? "").replace(/\/+$/, "");
    const io = { clock: this.now };
    if (!base)
      return io;
    const call = /* @__PURE__ */ __name(async (path, init) => {
      const key = this.env.CHAT_SERVICE_PRIVATE_KEY;
      if (!key)
        throw new Error("service key is not configured");
      const token = await signServiceToken(key, { kid: this.env.CHAT_SERVICE_KID ?? "hfy-chat-1", now: this.now() });
      const f = this.options.fetch ?? ((u, i) => globalThis.fetch(u, i));
      const res = await f(`${base}${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...init.body !== void 0 ? { "content-type": "application/json" } : {} },
        ...init.body !== void 0 ? { body: JSON.stringify(init.body) } : {},
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      });
      if (!res.ok)
        throw new Error(`api ${path} http ${res.status}`);
      return res.json().catch(() => ({}));
    }, "call");
    const directory = {
      async fetch() {
        const body = await call("/chat/directory", { method: "GET" });
        if (!Array.isArray(body.members))
          throw new Error("directory: bad shape");
        return body.members.map((m) => {
          const r = m;
          if (typeof r.id !== "string" || !UID_RE.test(r.id) || typeof r.label !== "string")
            throw new Error("directory: bad member");
          return { id: r.id, label: cleanLabel(r.label, r.id) };
        });
      }
    };
    const push = {
      async send(items) {
        await call("/chat/push", { method: "POST", body: { items } });
      }
    };
    const archive = {
      async post(b) {
        const res = await call("/chat/archive", {
          method: "POST",
          body: {
            conv: {
              id: b.conv.id,
              kind: b.conv.kind,
              name: b.conv.name,
              creator: b.conv.creator,
              policy: b.conv.policy,
              created_at: b.conv.createdAt,
              last_seq: b.conv.lastSeq
            },
            members: b.members.map((e) => ({ uid: e.uid, epoch: e.epoch, join_seq: e.joinSeq, left_seq: e.leftSeq, invited_by: e.invitedBy })),
            msgs: b.msgs.map((m) => ({
              seq: m.seq,
              cmid: m.cmid,
              from: m.from,
              kind: m.kind,
              ...m.kind === "msg" ? { text: m.text ?? "" } : { sys: m.sys },
              ts: m.ts
            }))
          }
        });
        return typeof res.through_seq === "number" ? { throughSeq: res.through_seq } : void 0;
      }
    };
    return { ...io, directory, push, archive };
  }
};
function defaultLog(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}
__name(defaultLog, "defaultLog");
function upgradeResponse(client) {
  return new Response(null, { status: 101, webSocket: client });
}
__name(upgradeResponse, "upgradeResponse");
function chatHubClass(options) {
  return class extends ChatHub {
    constructor(ctx, env) {
      super(ctx, env, options);
    }
  };
}
__name(chatHubClass, "chatHubClass");

// node_modules/@io-kit/chat/dist/src/cloudflare/worker.js
var noStore = { "cache-control": "no-store" };
function json2(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...noStore } });
}
__name(json2, "json");
var PASS_HEADERS = ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"];
function createChatWorker(config = {}) {
  const wsPath = config.wsPath ?? "/chat/ws";
  const basePath = (config.basePath ?? "/chat/v1").replace(/\/+$/, "");
  const verifiers = /* @__PURE__ */ new Map();
  function pair() {
    if (config.webSocketPair)
      return config.webSocketPair();
    const P = globalThis.WebSocketPair;
    if (!P)
      throw new Error("WebSocketPair is not available in this runtime");
    const p = new P();
    return [p[0], p[1]];
  }
  __name(pair, "pair");
  function upgraded(client) {
    return config.upgrade ? config.upgrade(client) : new Response(null, { status: 101, webSocket: client });
  }
  __name(upgraded, "upgraded");
  function refuse(code, reason) {
    const [client, server] = pair();
    server.accept?.();
    server.close(code, reason);
    return upgraded(client);
  }
  __name(refuse, "refuse");
  function verifierFor(env) {
    const issuer = env.SESSION_ISSUER;
    const audience = env.SESSION_AUDIENCE;
    const jwksUrl = env.SESSION_JWKS_URL;
    if (!issuer || !audience || !jwksUrl)
      return null;
    const cookie = env.SESSION_COOKIE ?? DEFAULT_SESSION_CONFIG.cookie;
    const key = JSON.stringify([issuer, audience, jwksUrl, cookie]);
    let v = verifiers.get(key);
    if (!v) {
      v = createSessionVerifier({ issuer, audience, jwksUrl, cookie, ...config.session }, { ...config.fetch ? { fetch: config.fetch } : {}, ...config.now ? { now: config.now } : {} });
      verifiers.set(key, v);
    }
    return v;
  }
  __name(verifierFor, "verifierFor");
  async function upgrade(request, env) {
    const origin = request.headers.get("origin");
    if (!env.SITE_ORIGIN || origin !== env.SITE_ORIGIN)
      return refuse(CLOSE_CODES.forbidden, "origin");
    if (env.CHAT_ENABLED !== "1")
      return refuse(CLOSE_CODES.disabled, "chat disabled");
    const verifier = verifierFor(env);
    if (!verifier)
      return refuse(CLOSE_CODES.disabled, "session settings missing");
    const session = await verifier.verifyCookie(request.headers.get("cookie"));
    if (!session.ok) {
      return session.reason === "jwks-unavailable" ? refuse(CLOSE_CODES.disabled, "keys unavailable") : refuse(CLOSE_CODES.unauthenticated, "unauthenticated");
    }
    const { sub, exp } = session.claims;
    const expSeconds = Math.floor(exp);
    if (!Number.isSafeInteger(expSeconds) || expSeconds < 0 || expSeconds >= 1e12)
      return refuse(CLOSE_CODES.unauthenticated, "bad expiry");
    if (env.CHAT_OPEN_TO !== "all") {
      const uat = (env.CHAT_UAT_SUBJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!uat.includes(sub))
        return refuse(CLOSE_CODES.forbidden, "not in uat");
    }
    const headers = new Headers();
    for (const h of PASS_HEADERS) {
      const v = request.headers.get(h);
      if (v !== null)
        headers.set(h, v);
    }
    headers.set("x-chat-uid", sub);
    headers.set("x-chat-exp", String(expSeconds));
    const id = env.CHAT_HUB.idFromName(config.hubName ?? HUB_NAME);
    const hub = env.CHAT_HUB.get(id, { locationHint: config.locationHint ?? env.CHAT_LOCATION_HINT ?? HUB_LOCATION_HINT });
    return hub.fetch(new Request("https://chat-hub.internal/ws", { method: "GET", headers }));
  }
  __name(upgrade, "upgrade");
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === wsPath) {
        if (request.method !== "GET")
          return json2(405, { error: "method_not_allowed" });
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
          return json2(426, { error: "upgrade_required" });
        return upgrade(request, env);
      }
      if (path === `${basePath}/health`) {
        if (request.method !== "GET")
          return json2(405, { error: "method_not_allowed" });
        return json2(200, { ok: true, version: config.version ?? env.CHAT_WORKER_VERSION ?? "dev", protocol: PROTOCOL_VERSION });
      }
      return json2(404, { error: "not_found" });
    }
  };
}
__name(createChatWorker, "createChatWorker");

// ../shared/privacy-guard.mjs
var KINDS = Object.freeze(["phone", "email", "street_address", "po_box", "contact_url", "dob_heuristic"]);
var DOB_KINDS = Object.freeze(["dob_heuristic"]);
var DOB_WINDOW = 60;
var COPY = Object.freeze({
  contact_info: "this looks like a phone number or street address. we don't keep those on the site, so please remove it to continue.",
  dob_not_allowed: "we only keep the birth year on the site."
});
var BIRTHDAY_KEYWORDS = /* @__PURE__ */ new Set([
  "birthday",
  "birthdays",
  "bday",
  "bdays",
  "b-day",
  "b-days",
  "b'day",
  "b'days",
  "hbd",
  "birthdate",
  "birthdates",
  "birth date",
  "date of birth",
  "dob",
  "d.o.b",
  "born",
  "birth",
  "births",
  "baptized",
  "baptised",
  "baptism",
  "christened",
  "christening"
]);
var EVENT_WORDS = [
  "died",
  "dies",
  "death",
  "deaths",
  "deceased",
  "passed away",
  "buried",
  "burial",
  "interred",
  "married",
  "marriage",
  "marries",
  "marry",
  "wedding",
  "divorced",
  "divorce",
  "anniversary",
  "graduated",
  "graduation",
  "emigrated",
  "immigrated",
  "naturalized",
  "naturalised",
  "enlisted",
  "discharged",
  "retired",
  "census",
  "enumerated",
  "enumeration"
];
var BIRTH_ABBREVIATIONS = ["b.", "bap.", "bapt.", "chr."];
var EVENT_ABBREVIATIONS = ["d.", "m.", "bur.", "div."];
var CONTACT_HOSTS = Object.freeze([
  "m.me",
  "ig.me",
  "wa.me",
  "wa.link",
  "t.me",
  "telegram.me",
  "telegram.dog",
  "messenger.com",
  "api.whatsapp.com",
  "chat.whatsapp.com",
  "signal.me",
  "signal.group"
]);
var CONTACT_PATHS = Object.freeze([["instagram.com", "m"], ["instagram.com", "direct"], ["facebook.com", "messages"]]);
var CONTACT_SCHEMES = Object.freeze([
  "mailto",
  "tel",
  "sms",
  "smsto",
  "mms",
  "callto",
  "facetime",
  "facetime-audio",
  "skype",
  "whatsapp",
  "viber",
  "sgnl",
  "tg",
  "fb-messenger",
  "imessage"
]);
var FOLD = Object.freeze([
  [160, 160, 32, 0],
  [183, 183, 46, 0],
  [700, 700, 39, 0],
  [5760, 5760, 32, 0],
  [8192, 8202, 32, 0],
  [8208, 8213, 45, 0],
  [8216, 8217, 39, 0],
  [8228, 8228, 46, 0],
  [8232, 8233, 32, 0],
  [8239, 8239, 32, 0],
  [8287, 8287, 32, 0],
  [8722, 8722, 45, 0],
  [12288, 12288, 32, 0],
  [65112, 65112, 45, 0],
  [65123, 65123, 45, 0],
  [65131, 65131, 64, 0],
  [65281, 65374, 33, 1]
].map((r) => Object.freeze(r)));
var DIGITS = Object.freeze([
  [178, 179, 2],
  [185, 185, 1],
  [1632, 1641, 0],
  [1776, 1785, 0],
  [1984, 1993, 0],
  [2406, 2415, 0],
  [2534, 2543, 0],
  [2662, 2671, 0],
  [2790, 2799, 0],
  [2918, 2927, 0],
  [3046, 3055, 0],
  [3174, 3183, 0],
  [3302, 3311, 0],
  [3430, 3439, 0],
  [3558, 3567, 0],
  [3664, 3673, 0],
  [3792, 3801, 0],
  [3872, 3881, 0],
  [4160, 4169, 0],
  [4240, 4249, 0],
  [6112, 6121, 0],
  [6160, 6169, 0],
  [6470, 6479, 0],
  [6608, 6617, 0],
  [6784, 6793, 0],
  [6800, 6809, 0],
  [6992, 7001, 0],
  [7088, 7097, 0],
  [7232, 7241, 0],
  [7248, 7257, 0],
  [8304, 8304, 0],
  [8308, 8313, 4],
  [8320, 8329, 0],
  [9312, 9331, 1],
  [9450, 9450, 0],
  [12881, 12895, 21],
  [12977, 12991, 36],
  [42528, 42537, 0],
  [43216, 43225, 0],
  [43264, 43273, 0],
  [43472, 43481, 0],
  [43504, 43513, 0],
  [43600, 43609, 0],
  [44016, 44025, 0],
  [66720, 66729, 0],
  [68912, 68921, 0],
  [69734, 69743, 0],
  [69872, 69881, 0],
  [69942, 69951, 0],
  [70096, 70105, 0],
  [70384, 70393, 0],
  [70736, 70745, 0],
  [70864, 70873, 0],
  [71248, 71257, 0],
  [71360, 71369, 0],
  [71472, 71481, 0],
  [71904, 71913, 0],
  [72016, 72025, 0],
  [72784, 72793, 0],
  [73040, 73049, 0],
  [73120, 73129, 0],
  [73552, 73561, 0],
  [92768, 92777, 0],
  [92864, 92873, 0],
  [93008, 93017, 0],
  [120782, 120791, 0],
  [120792, 120801, 0],
  [120802, 120811, 0],
  [120812, 120821, 0],
  [120822, 120831, 0],
  [123200, 123209, 0],
  [123632, 123641, 0],
  [124144, 124153, 0],
  [125264, 125273, 0],
  [130032, 130041, 0]
].map((r) => Object.freeze(r)));
var DROP = Object.freeze([
  [173, 173],
  [847, 847],
  [1564, 1564],
  [4447, 4448],
  [6068, 6069],
  [6155, 6159],
  [8203, 8207],
  [8234, 8238],
  [8288, 8303],
  [12644, 12644],
  [65024, 65039],
  [65279, 65279],
  [65440, 65440],
  [65520, 65528],
  [113824, 113827],
  [119155, 119162],
  [917504, 921599]
].map((r) => Object.freeze(r)));
var NORM = /* @__PURE__ */ new Map();
for (const [lo, hi, out, step] of FOLD) {
  for (let cp = lo; cp <= hi; cp++) NORM.set(cp, String.fromCharCode(out + (cp - lo) * step));
}
for (const [lo, hi, value] of DIGITS) for (let cp = lo; cp <= hi; cp++) NORM.set(cp, String(value + cp - lo));
for (const [lo, hi] of DROP) for (let cp = lo; cp <= hi; cp++) NORM.set(cp, "");
var hex = /* @__PURE__ */ __name((n) => "\\u" + n.toString(16).padStart(4, "0"), "hex");
var NEEDS_NORM = new RegExp("[" + [...FOLD, ...DIGITS, ...DROP].filter(([lo]) => lo <= 65535).map(([lo, hi]) => lo === hi ? hex(lo) : hex(lo) + "-" + hex(hi)).join("") + "\\ud800-\\udfff]");
var ASTRAL = "\uFFFD";
function normalize(text) {
  if (!NEEDS_NORM.test(text)) return { t: text, from: null, to: null };
  const out = [], from = [], to = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const next = i + (cp > 65535 ? 2 : 1);
    const rep = NORM.get(cp);
    const s = rep !== void 0 ? rep : cp > 65535 ? ASTRAL : text[i];
    for (let k = 0; k < s.length; k++) {
      out.push(s[k]);
      from.push(i);
      to.push(next);
    }
    i = next;
  }
  return { t: out.join(""), from, to };
}
__name(normalize, "normalize");
var WORD_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";
var SPACE_CHARS = " 	\r\n\f\v";
var isWordChar = /* @__PURE__ */ __name((ch) => ch !== void 0 && ch !== "" && WORD_CHARS.includes(ch), "isWordChar");
var isDigit = /* @__PURE__ */ __name((ch) => ch !== void 0 && ch !== "" && "0123456789".includes(ch), "isDigit");
var escapeRe = /* @__PURE__ */ __name((s) => s.replace(/[.*+?^${}()|[\]\\\-']/g, "\\$&"), "escapeRe");
var byLength = /* @__PURE__ */ __name((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0), "byLength");
var alternation = /* @__PURE__ */ __name((words) => [...words].sort(byLength).map((w) => escapeRe(w).replace(/ /g, "[ \\t]+")).join("|"), "alternation");
var PHONE_RUN = /(?:\+[ \t]?)?(?:\([ \t]?)?[0-9]+(?:[ \t]?\))?(?:(?:[ \t]{0,2}[\-\/][ \t]{0,2}|\.|[ \t]{1,2})?(?:\([ \t]?)?[0-9]+(?:[ \t]?\))?)*/g;
var DIGIT_GROUP = /[0-9]+/g;
var AREA_CODE = /^\([ \t]?[0-9]{1,5}[ \t]?\)/;
var YEAR_LIKE = /^(?:1[0-9]{3}|20[0-9]{2})$/;
var HOST_PATH = /[A-Za-z0-9\-]\.[A-Za-z]{2,24}(?::[0-9]{1,5})?[\/?#]/g;
var PHONE_WORD = /\b(?:tel|tele|telephone|phone|ph|cell|cellphone|mobile|mob|call|text|txt|fax|whatsapp)\b/i;
var REFERENCE = new RegExp(
  "\\b(?:" + alternation([
    "p",
    "pp",
    "pg",
    "pgs",
    "page",
    "pages",
    "vol",
    "vols",
    "volume",
    "no",
    "nos",
    "nr",
    "film",
    "roll",
    "fiche",
    "folio",
    "fol",
    "item",
    "image",
    "img",
    "dgs",
    "cert",
    "certificate",
    "record",
    "rec",
    "ref",
    "reference",
    "id",
    "isbn",
    "issn",
    "case",
    "file",
    "lot",
    "plot",
    "grave",
    "row",
    "sec",
    "section",
    "entry",
    "frame",
    "register",
    "reg",
    "batch",
    "serial",
    "census",
    "book",
    "bk",
    "chapter",
    "ch",
    "memorial",
    "find a grave",
    "serial number",
    "service number",
    "database",
    "accession"
  ]) + ")\\.?[ \\t]*(?:[:#][ \\t]*)?$",
  "i"
);
var sepCore = /* @__PURE__ */ __name((sep) => sep.replace(/[ \t()]/g, ""), "sepCore");
var dayMonth = /* @__PURE__ */ __name((a, b) => a >= 1 && b >= 1 && (a <= 12 && b <= 31 || a <= 31 && b <= 12), "dayMonth");
var phoneShaped = /* @__PURE__ */ __name((lens) => lens.length <= 5 && lens[0] <= 4 && lens.slice(1).every((l) => l >= 2 && l <= 4), "phoneShaped");
var fiveTwos = /* @__PURE__ */ __name((groups, seps, from) => groups.length - from === 5 && groups.slice(from).every((g) => g.d.length === 2) && seps.slice(from).every((s) => s === seps[from]), "fiveTwos");
function isDateTriple(groups, seps) {
  const [ca, cb] = seps.map(sepCore);
  if (ca !== cb) return false;
  const [a, b, c] = groups.map((g) => g.d);
  if (a.length === 4 && b.length <= 2 && c.length <= 2) return +b >= 1 && +b <= 12 && +c >= 1 && +c <= 31;
  if (a.length <= 2 && b.length <= 2 && (c.length === 2 || c.length === 4)) return dayMonth(+a, +b);
  return false;
}
__name(isDateTriple, "isDateTriple");
function urlPrefixes(t) {
  const url = new Uint8Array(t.length + 1);
  for (let k = t.indexOf("://"); k !== -1; k = t.indexOf("://", k + 1)) url[k + 3] = 1;
  for (const m of t.matchAll(HOST_PATH)) url[m.index + m[0].length] = 1;
  let on = 0;
  for (let p = 1; p <= t.length; p++) {
    if (SPACE_CHARS.includes(t[p - 1])) on = 0;
    else if (url[p]) on = 1;
    url[p] = on;
  }
  return url;
}
__name(urlPrefixes, "urlPrefixes");
function phoneExcluded(groups, seps, before) {
  const lens = groups.map((g) => g.d.length);
  const n = lens.reduce((x, y) => x + y, 0);
  const core = seps.map(sepCore);
  if (groups.every((g) => YEAR_LIKE.test(g.d))) return true;
  if (groups.length === 3 && isDateTriple(groups, seps)) return true;
  if (lens.every((l) => l <= 2) && n < 10) return true;
  if (groups.length >= 3 && seps.every((s) => s === seps[0]) && (seps[0] === "." || seps[0] === " ") && lens[0] <= 3 && lens.slice(1).every((l) => l === 3)) return true;
  if (groups.length === 2) {
    const [a, b] = groups.map((g) => +g.d);
    if (core[0] === "-" && lens[0] === lens[1] && b > a && b - a < 10 ** (lens[0] - 1)) return true;
    if (core[0] === "" && Math.min(lens[0], lens[1]) <= 4 && groups.some((g) => YEAR_LIKE.test(g.d))) return true;
  }
  return REFERENCE.test(before) && !phoneShaped(lens);
}
__name(phoneExcluded, "phoneExcluded");
function phoneVerdict(t, s, run, groups, inUrl) {
  const seps = groups.slice(1).map((g, i) => run.slice(groups[i].at + groups[i].d.length, g.at));
  let n = groups.reduce((x, g) => x + g.d.length, 0);
  for (let from = 0; ; from += 3) {
    if (from > 0) n -= groups[from - 3].d.length + groups[from - 2].d.length + groups[from - 1].d.length;
    if (n < 7) return null;
    const off = groups[from].at;
    if (from === 0 && run[0] === "+") return { off: 0, rule: "plus" };
    const before = t.slice(Math.max(0, s + off - 24), s + off);
    if (groups.length - from === 1) {
      if (n > 15 || inUrl(s + off) || REFERENCE.test(before)) return null;
      return { off, rule: "run" };
    }
    if (!AREA_CODE.test(run.slice(from === 0 ? 0 : off, off + 9)) && !PHONE_WORD.test(before)) {
      if (groups.length - from > 3 && isDateTriple(groups.slice(from, from + 3), seps.slice(from, from + 2)) && !fiveTwos(groups, seps, from)) continue;
      if (phoneExcluded(groups.slice(from), seps.slice(from), before)) return null;
    }
    return { off: from === 0 ? 0 : off, rule: "grouped" };
  }
}
__name(phoneVerdict, "phoneVerdict");
function unwrap(run) {
  let a = 0, b = run.length;
  if (run[0] === "(" && !AREA_CODE.test(run)) {
    a = 1;
    while (a < b && " 	".includes(run[a])) a++;
  }
  const inner = run.slice(a, b);
  if (run[b - 1] === ")" && inner.split(")").length > inner.split("(").length) {
    b--;
    while (b > a && " 	".includes(run[b - 1])) b--;
  }
  return [a, b];
}
__name(unwrap, "unwrap");
function scanPhones(t, add) {
  let url = null;
  const inUrl = /* @__PURE__ */ __name((pos) => pos > 0 && "/=?&#".includes(t[pos - 1]) && (url || (url = urlPrefixes(t)))[pos] === 1, "inUrl");
  for (const m of t.matchAll(PHONE_RUN)) {
    if (m.index > 0 && isWordChar(t[m.index - 1])) continue;
    const [a, b] = unwrap(m[0]);
    const s = m.index + a;
    const run = m[0].slice(a, b);
    if (!run) continue;
    const groups = [...run.matchAll(DIGIT_GROUP)].map((g) => ({ at: g.index, d: g[0] }));
    const v = phoneVerdict(t, s, run, groups, inUrl);
    if (v) add("phone", s + v.off, s + run.length, v.rule);
  }
}
__name(scanPhones, "scanPhones");
var LOCAL_CHARS = WORD_CHARS + ".%+-";
var DOMAIN = /(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24}\b/y;
var DOMAIN_SPELLED = /(?:[A-Za-z0-9\-]{1,63}(?:[ \t]*(?:\[dot\]|\(dot\)|\{dot\}|<dot>)[ \t]*|[ \t]+dot[ \t]+|\.)){1,8}[A-Za-z]{2,24}\b/iy;
var AT_SPELLED = /(?:\[at\]|\(at\)|\{at\}|<at>)[ \t]*/gi;
function localStart(t, at, spaced) {
  if (spaced) while (at > 0 && " 	".includes(t[at - 1])) at--;
  let i = at;
  while (i > 0 && at - i < 64 && LOCAL_CHARS.includes(t[i - 1])) i--;
  while (i < at && ".-".includes(t[i])) i++;
  for (let j = i; j < at; j++) if (WORD_CHARS.includes(t[j]) && t[j] !== "_") return i;
  return -1;
}
__name(localStart, "localStart");
function domainEnd(t, pos, plainOk) {
  if (plainOk) {
    DOMAIN.lastIndex = pos;
    const m2 = DOMAIN.exec(t);
    if (m2) return { end: pos + m2[0].length, spelled: false };
  }
  DOMAIN_SPELLED.lastIndex = pos;
  const m = DOMAIN_SPELLED.exec(t);
  return m ? { end: pos + m[0].length, spelled: true } : null;
}
__name(domainEnd, "domainEnd");
function scanEmails(t, add) {
  for (let at = t.indexOf("@"); at !== -1; at = t.indexOf("@", at + 1)) {
    const s = localStart(t, at);
    const d = s === -1 ? null : domainEnd(t, at + 1, true);
    if (d) add("email", s, d.end, d.spelled ? "spelled" : "address");
  }
  for (const m of t.matchAll(AT_SPELLED)) {
    const s = localStart(t, m.index, true);
    const d = s === -1 ? null : domainEnd(t, m.index + m[0].length, true);
    if (d) add("email", s, d.end, "spelled");
  }
}
__name(scanEmails, "scanEmails");
var STREET_STOP = [
  "to",
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "of",
  "and",
  "or",
  "from",
  "by",
  "for",
  "with",
  "near",
  "he",
  "she",
  "they",
  "we",
  "it",
  "was",
  "were",
  "is",
  "are",
  "his",
  "her",
  "their",
  "our",
  "my",
  "moved",
  "lived",
  "went",
  "times",
  "years",
  "months",
  "weeks",
  "days",
  "hours",
  "minutes",
  "kids",
  "children",
  "sons",
  "daughters",
  "people",
  "miles",
  "acres",
  "feet",
  "generations",
  "grandchildren",
  "cousins",
  "siblings",
  "brothers",
  "sisters",
  "year",
  "month",
  "week",
  "day",
  "hour",
  "minute",
  "foot",
  "percent",
  "degree",
  "degrees"
];
var STRONG_SUFFIXES = [
  "street",
  "st",
  "avenue",
  "ave",
  "av",
  "road",
  "rd",
  "lane",
  "ln",
  "drive",
  "dr",
  "boulevard",
  "blvd",
  "highway",
  "hwy",
  "parkway",
  "pkwy",
  "turnpike",
  "tpke",
  "expressway",
  "expy",
  "freeway",
  "fwy",
  "pike",
  "alley",
  "aly",
  "crescent",
  "cres"
];
var WEAK_SUFFIXES = [
  "court",
  "ct",
  "place",
  "pl",
  "terrace",
  "ter",
  "way",
  "circle",
  "cir",
  "square",
  "sq",
  "trail",
  "trl",
  "close",
  "row",
  "loop",
  "path",
  "walk",
  "plaza",
  "plz",
  "grove",
  "grv",
  "glen",
  "gardens",
  "gdns",
  "heights",
  "hts",
  "hill",
  "park",
  "point",
  "ridge",
  "rdg",
  "cove",
  "manor",
  "mews",
  "vale",
  "wynd",
  "quay",
  "crossing",
  "xing",
  "bend",
  "trace",
  "esplanade",
  "promenade"
];
var STRONG = new Set(STRONG_SUFFIXES);
var STREET = new RegExp(
  "\\b([0-9]{1,6})([A-Za-z]?)(?:-[0-9]{1,5}[A-Za-z]?)?[ \\t]+(?:(?!(?:" + alternation(STREET_STOP) + ")\\b)(?:[A-Za-z][A-Za-z'.\\-]*|[0-9]{1,3}(?:st|nd|rd|th))[ \\t]+){1,4}?(" + alternation([...STRONG_SUFFIXES, ...WEAK_SUFFIXES]) + ")\\b\\.?",
  "gi"
);
var PO_BOX = /\b(?:g?p[ \t]*(?:\.[ \t]*)?o\.?[ \t]*|post[ \t]+office[ \t]+)box[ \t]*(?:no\.?[ \t]*|#[ \t]*)?[0-9]{1,8}\b|\bpmb[ \t]*(?:#[ \t]*)?[0-9]{1,8}\b/gi;
var ROUTE = "(?:r\\.?[ \\t]*r\\.?|r\\.?[ \\t]*f\\.?[ \\t]*d\\.?|h\\.?[ \\t]*c\\.?|rural[ \\t]+route|highway[ \\t]+contract|star[ \\t]+route|route|rte\\.?|rt\\.?)[ \\t]*(?:#[ \\t]*)?[0-9]{1,4}";
var RURAL_BOX = new RegExp(
  `\\b${ROUTE}[ \\t]*(?:,[ \\t]*)?box[ \\t]*(?:#[ \\t]*)?[0-9]{1,6}\\b|\\bbox[ \\t]*(?:#[ \\t]*)?[0-9]{1,6}[ \\t]*(?:,[ \\t]*)?${ROUTE}\\b`,
  "gi"
);
var YEAR_WORDS = /* @__PURE__ */ new Set(["in", "by", "since", "until", "circa", "ca.", "c."]);
function wordBefore(t, i) {
  let e = i;
  while (e > 0 && " 	".includes(t[e - 1])) e--;
  if (e === i) return "";
  let s = e > 0 && t[e - 1] === "." ? e - 1 : e;
  while (s > 0 && e - s < 8 && isWordChar(t[s - 1])) s--;
  return s > 0 && isWordChar(t[s - 1]) ? "" : t.slice(s, e).toLowerCase();
}
__name(wordBefore, "wordBefore");
function scanAddresses(t, add) {
  for (const m of t.matchAll(STREET)) {
    if (!m[2] && YEAR_LIKE.test(m[1])) {
      if (!STRONG.has(m[3].toLowerCase()) || YEAR_WORDS.has(wordBefore(t, m.index))) continue;
    }
    add("street_address", m.index, m.index + m[0].length, "number-street");
  }
  for (const m of t.matchAll(RURAL_BOX)) add("street_address", m.index, m.index + m[0].length, "rural-route");
  for (const m of t.matchAll(PO_BOX)) add("po_box", m.index, m.index + m[0].length, "box");
}
__name(scanAddresses, "scanAddresses");
var SCHEME = new RegExp("\\b(?:" + alternation(CONTACT_SCHEMES) + `):[^ \\t\\r\\n\\f\\v<>"']+`, "gi");
var URLISH = /(?:[A-Za-z][A-Za-z0-9+.\-]{0,20}:\/\/)?((?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.){1,8}[A-Za-z]{2,24})(?![A-Za-z0-9\-])(?::[0-9]{1,5})?([\/?#][^ \t\r\n\f\v<>"']*)?/g;
var TRAILING = `.,;:!?)]}'"`;
var normHost = /* @__PURE__ */ __name((host) => String(host).toLowerCase().replace(/\.+$/, ""), "normHost");
var matchesDomain = /* @__PURE__ */ __name((host, domain) => {
  const h = normHost(host);
  return h === domain || h.endsWith("." + domain);
}, "matchesDomain");
var firstSegment = /* @__PURE__ */ __name((path) => String(path || "").replace(/^\//, "").split(/[\/?#]/)[0].toLowerCase(), "firstSegment");
function isContactChannel(host, path = "") {
  if (CONTACT_HOSTS.some((d) => matchesDomain(host, d))) return true;
  const seg = firstSegment(path);
  return CONTACT_PATHS.some(([d, s]) => seg === s && matchesDomain(host, d));
}
__name(isContactChannel, "isContactChannel");
function trimEnd(t, start, end) {
  while (end > start && TRAILING.includes(t[end - 1])) end--;
  return end;
}
__name(trimEnd, "trimEnd");
function scanContactUrls(t, add) {
  for (const m of t.matchAll(SCHEME)) add("contact_url", m.index, trimEnd(t, m.index, m.index + m[0].length), "scheme");
  for (const m of t.matchAll(URLISH)) {
    const s = m.index;
    if (s > 0 && (isWordChar(t[s - 1]) || "@.-".includes(t[s - 1]))) continue;
    const host = m[1].toLowerCase();
    const viaHost = CONTACT_HOSTS.some((d) => matchesDomain(host, d));
    if (!viaHost && !isContactChannel(host, m[2] || "")) continue;
    const hostEnd = m[0].indexOf(m[1]) + m[1].length;
    add("contact_url", s, trimEnd(t, s + hostEnd, s + m[0].length), viaHost ? "host" : "path");
  }
}
__name(scanContactUrls, "scanContactUrls");
var MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
var DAY = "(?:3[01]|[12][0-9]|0?[1-9])";
var ORD = "(?:st|nd|rd|th)";
var UNITS = "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)";
var WORD_ORD = `(?:twenty[ \\t\\-]?${UNITS}|thirty[ \\t\\-]?first|${UNITS}|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)`;
var YEAR_TAIL = "(?:,?[ \\t]*(?:[0-9]{4}|'[0-9]{2})\\b)?";
var DATE_FORMS = [
  ["month-day", new RegExp(`\\b${MONTH}\\b\\.?(?:[ \\t]+the)?[ \\t]+(?:${DAY}${ORD}?|${WORD_ORD})\\b${YEAR_TAIL}`, "gi"), null],
  ["day-month", new RegExp(`\\b(?:${DAY}${ORD}?(?:[ \\t]+of)?|${WORD_ORD}[ \\t]+of)[ \\t]+${MONTH}\\b\\.?${YEAR_TAIL}`, "gi"), null],
  ["numeric", /\b[0-9]{4}([\-\/.])(?:1[0-2]|0?[1-9])\1(?:3[01]|[12][0-9]|0?[1-9])\b/g, "free"],
  ["numeric", /\b([0-9]{1,2})([\-\/.])([0-9]{1,2})\2(?:[0-9]{4}|[0-9]{2})\b/g, "dmy"],
  ["numeric", /\b([0-9]{1,2})\/([0-9]{1,2})\b/g, "md"],
  // full dates with the month as letters: 5-Mar-1950, 05MAR1950, 5/mar/50 and Mar-05-1950, Mar.5.50
  ["day-month", new RegExp(`\\b${DAY}([\\-\\/.]?)${MONTH}\\1(?:[0-9]{4}|[0-9]{2})\\b`, "gi"), null],
  ["month-day", new RegExp(`\\b${MONTH}([\\-\\/.])${DAY}\\1(?:[0-9]{4}|[0-9]{2})\\b`, "gi"), null],
  ["month-year", new RegExp(`\\b${MONTH}\\b\\.?,?[ \\t]+(?:of[ \\t]+)?[0-9]{4}\\b`, "gi"), null],
  ["month-year", /\b(?:1[0-2]|0?[1-9])\/[0-9]{4}\b/g, "free"]
];
var RULE_ORDER = ["month-day", "day-month", "numeric", "month-year"];
var WORD_KEYWORD = new RegExp("\\b(?:" + alternation([...BIRTHDAY_KEYWORDS, ...EVENT_WORDS]) + ")\\b", "gi");
var ABBR_KEYWORD = new RegExp("\\b(?:" + alternation([...BIRTH_ABBREVIATIONS, ...EVENT_ABBREVIATIONS].map((a) => a.slice(0, -1))) + ")\\.", "g");
var BIRTH_ABBR = new Set(BIRTH_ABBREVIATIONS);
function numericIsolated(t, s, e) {
  const sepDigit = /* @__PURE__ */ __name((i, j) => "-/.".includes(t[i] || "x") && isDigit(t[j]), "sepDigit");
  return !sepDigit(e, e + 1) && !(s >= 2 && sepDigit(s - 1, s - 2));
}
__name(numericIsolated, "numericIsolated");
function dateCandidates(t) {
  const found = [];
  for (const [rule, re, check] of DATE_FORMS) {
    for (const m of t.matchAll(re)) {
      const s = m.index, e = s + m[0].length;
      if (check) {
        if (!numericIsolated(t, s, e)) continue;
        if (check === "dmy" && !dayMonth(+m[1], +m[3])) continue;
        if (check === "md" && !dayMonth(+m[1], +m[2])) continue;
      }
      found.push({ start: s, end: e, rule });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));
  const out = [];
  for (const c of found) if (!out.length || c.start >= out[out.length - 1].end) out.push(c);
  return out;
}
__name(dateCandidates, "dateCandidates");
function keywords(t) {
  const words = [...t.matchAll(WORD_KEYWORD)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    birth: BIRTHDAY_KEYWORDS.has(m[0].toLowerCase().replace(/[ \t]+/g, " "))
  }));
  const abbrs = [];
  let w = 0;
  for (const m of t.matchAll(ABBR_KEYWORD)) {
    const s = m.index, e = s + m[0].length;
    if (s > 0 && ".'".includes(t[s - 1])) continue;
    while (w < words.length && words[w].end <= s) w++;
    if (w < words.length && words[w].start < e) continue;
    abbrs.push({ start: s, end: e, birth: BIRTH_ABBR.has(m[0]) });
  }
  return [...words, ...abbrs].sort((a, b) => a.start - b.start);
}
__name(keywords, "keywords");
function scanDob(t, add) {
  const dates = dateCandidates(t);
  if (!dates.length) return;
  const kws = keywords(t);
  let before = 0, after = 0;
  for (const d of dates) {
    while (before < kws.length && kws[before].end <= d.start) before++;
    while (after < kws.length && kws[after].start < d.end) after++;
    let best = Infinity, birth = false;
    if (before > 0 && d.start - kws[before - 1].end <= DOB_WINDOW) {
      best = d.start - kws[before - 1].end;
      birth = kws[before - 1].birth;
    }
    if (d.rule !== "month-year" && after < kws.length) {
      const gap = kws[after].start - d.end;
      if (gap <= DOB_WINDOW && (gap < best || gap === best && kws[after].birth)) birth = kws[after].birth;
    }
    if (birth) add("dob_heuristic", d.start, d.end, d.rule);
  }
}
__name(scanDob, "scanDob");
var DETECTORS = [scanPhones, scanEmails, scanAddresses, scanContactUrls, scanDob];
function scanText(text, opts = {}) {
  if (text === null || text === void 0) return [];
  if (typeof text !== "string") throw new TypeError("scanText: text must be a string");
  const want = opts && opts.kinds != null ? new Set(opts.kinds) : null;
  const { t, from, to } = normalize(text);
  const hits = [];
  const seen = /* @__PURE__ */ new Set();
  const add = /* @__PURE__ */ __name((kind, start, end, rule) => {
    if (want && !want.has(kind) || end <= start) return;
    if (from) [start, end] = [from[start], to[end - 1]];
    const key = kind + ":" + start + ":" + end;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind, start, end, rule });
  }, "add");
  for (const detect of DETECTORS) detect(t, add);
  return hits.sort((a, b) => a.start - b.start || a.end - b.end || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}
__name(scanText, "scanText");

// src/admin.mjs
var ADMIN_PATH = "/chat/v1/admin/expunge";
var HUB_ADMIN_PATH = "/admin/expunge";
var MIN_TOKEN_CHARS = 32;
var MAX_BODY_CHARS = 1024;
var CONV_RE = /^(?:dm:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}|g:[A-Za-z0-9]{1,40})$/;
var MAX_SEQ = 2147483647;
var json3 = /* @__PURE__ */ __name((status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } }), "json");
function adminConfigured(env) {
  return typeof env?.CHAT_ADMIN_TOKEN === "string" && env.CHAT_ADMIN_TOKEN.length >= MIN_TOKEN_CHARS;
}
__name(adminConfigured, "adminConfigured");
async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
__name(digest, "digest");
async function bearerOk(request, env) {
  if (!adminConfigured(env)) return false;
  const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(request.headers.get("authorization") ?? "");
  if (!m) return false;
  const [a, b] = await Promise.all([digest(m[1]), digest(env.CHAT_ADMIN_TOKEN)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
__name(bearerOk, "bearerOk");
async function readCapped(request) {
  const cap = MAX_BODY_CHARS * 4;
  if (Number(request.headers.get("content-length") ?? 0) > cap) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {
      });
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
__name(readCapped, "readCapped");
function parseBody(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_BODY_CHARS) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes("conv") || !keys.includes("seq")) return null;
  if (typeof v.conv !== "string" || !CONV_RE.test(v.conv)) return null;
  if (!Number.isSafeInteger(v.seq) || v.seq < 1 || v.seq > MAX_SEQ) return null;
  return { conv: v.conv, seq: v.seq };
}
__name(parseBody, "parseBody");

// src/common.mjs
var WS_PATH = "/chat/ws";
var HEALTH_PATH = "/chat/v1/health";
function contactGuard(text) {
  return scanText(text).map((hit) => [hit.start, hit.end, hit.kind]);
}
__name(contactGuard, "contactGuard");
function ownRequest(request) {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET") return false;
  if (path === HEALTH_PATH) return true;
  return path === WS_PATH && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}
__name(ownRequest, "ownRequest");
function adminRequest(request, env) {
  return request.method === "POST" && new URL(request.url).pathname === ADMIN_PATH && adminConfigured(env);
}
__name(adminRequest, "adminRequest");
async function handleAdmin(request, env) {
  if (!await bearerOk(request, env)) return json3(401, { error: "unauthorized" });
  const body = await readCapped(request);
  if (body === null || body.length > MAX_BODY_CHARS) return json3(413, { error: "too_large" });
  const id = env.CHAT_HUB.idFromName(HUB_NAME);
  const hub = env.CHAT_HUB.get(id, { locationHint: env.CHAT_LOCATION_HINT ?? HUB_LOCATION_HINT });
  return hub.fetch(
    new Request(`https://chat-hub.internal${HUB_ADMIN_PATH}`, {
      method: "POST",
      headers: { authorization: request.headers.get("authorization"), "content-type": "application/json" },
      body
    })
  );
}
__name(handleAdmin, "handleAdmin");
function passThrough(request, env) {
  if (env && env.CHAT_PASSTHROUGH === "off") return json3(404, { error: "not_found" });
  return fetch(request);
}
__name(passThrough, "passThrough");
function makeHandler(workerFor) {
  return /* @__PURE__ */ __name(async function fetchHandler(request, env, ctx) {
    if (adminRequest(request, env)) return handleAdmin(request, env);
    if (!ownRequest(request)) return passThrough(request, env);
    return workerFor(env).fetch(request, env, ctx);
  }, "fetchHandler");
}
__name(makeHandler, "makeHandler");

// src/expunge.mjs
function installReads(hub, sql) {
  const store = hub.store;
  const core = hub.core;
  if (typeof store?.visible !== "function" || typeof store?.archiveBatches !== "function" || typeof core?.toMsg !== "function") {
    throw new Error("expunge: the kit's hub no longer has store.visible, store.archiveBatches or core.toMsg");
  }
  const mark = /* @__PURE__ */ __name((conv, rows) => {
    const cand = rows.filter((r) => r.kind === "msg" && (r.text === "" || r.text === null));
    if (cand.length === 0) return rows;
    const lo = Math.min(...cand.map((r) => r.seq));
    const hi = Math.max(...cand.map((r) => r.seq));
    const gone = new Set(
      sql.exec("SELECT seq FROM msg WHERE conv = ? AND kind = 'msg' AND text IS NULL AND seq BETWEEN ? AND ?", conv, lo, hi).toArray().map((r) => Number(r.seq))
    );
    for (const r of cand) {
      if (gone.has(r.seq)) {
        r.text = null;
        r.expunged = true;
      }
    }
    return rows;
  }, "mark");
  const visible = store.visible.bind(store);
  store.visible = (uid, conv, q) => mark(conv, visible(uid, conv, q));
  const batches = store.archiveBatches.bind(store);
  store.archiveBatches = (maxMsgs, maxConvs) => {
    const out = batches(maxMsgs, maxConvs);
    for (const b of out) mark(b.conv.id, b.msgs);
    return out;
  };
  const toMsg = core.toMsg.bind(core);
  core.toMsg = (row) => row.kind === "msg" && row.expunged === true ? { conv: row.conv, seq: row.seq, cmid: row.cmid, from: row.from, ts: row.ts, kind: "msg", text: null, expunged: true } : toMsg(row);
}
__name(installReads, "installReads");
var SETTLE_ROUNDS = 20;
async function settleArchive(server) {
  for (let i = 0; i < SETTLE_ROUNDS && server?.archiving; i++) {
    try {
      await server.archiving;
    } catch {
    }
  }
  return !server?.archiving;
}
__name(settleArchive, "settleArchive");
function withExpunge(Base) {
  return class extends Base {
    #ctx;
    #env;
    constructor(...args) {
      super(...args);
      this.#ctx = args[0];
      this.#env = args[1] ?? {};
      installReads(this, this.#ctx.storage.sql);
    }
    async fetch(request) {
      if (new URL(request.url).pathname === HUB_ADMIN_PATH) return this.#admin(request);
      return super.fetch(request);
    }
    async #admin(request) {
      if (!await bearerOk(request, this.#env)) return adminConfigured(this.#env) ? json3(401, { error: "unauthorized" }) : json3(404, { error: "not_found" });
      if (request.method !== "POST") return json3(405, { error: "method_not_allowed" });
      const text = await readCapped(request);
      if (text === null || text.length > MAX_BODY_CHARS) return json3(413, { error: "too_large" });
      const ref = parseBody(text);
      if (!ref) return json3(400, { error: "bad_request" });
      await this.ready;
      await settleArchive(this.server);
      const sql = this.#ctx.storage.sql;
      const nulled = this.#ctx.storage.transactionSync(() => {
        if (this.server?.archiving) return "busy";
        const row = sql.exec("SELECT kind, text FROM msg WHERE conv = ? AND seq = ?", ref.conv, ref.seq).toArray()[0];
        if (!row) return null;
        if (row.kind !== "msg" || row.text === null || row.text === void 0) return 0;
        sql.exec("UPDATE msg SET text = NULL WHERE conv = ? AND seq = ? AND kind = 'msg'", ref.conv, ref.seq);
        return 1;
      });
      if (nulled === "busy") return json3(503, { error: "archive_busy" }, { "retry-after": "5" });
      return nulled === null ? json3(404, { error: "not_found" }) : json3(200, { nulled });
    }
  };
}
__name(withExpunge, "withExpunge");

// src/index.mjs
var ChatHub2 = withExpunge(chatHubClass({ contactGuard }));
var worker = createChatWorker();
var index_default = { fetch: makeHandler(() => worker) };
export {
  ChatHub2 as ChatHub,
  contactGuard,
  index_default as default
};
