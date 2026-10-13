// Cloudflare's published edge ranges (HFY-TSK-135, BRD2 surf-edge-clientip). Behind Cloudflare, CloudFront-Viewer-Address is a
// Cloudflare address and the real client is in CF-Connecting-IP, which is trusted only when the viewer address is in these ranges.
// Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6. Refresh occasionally; a test pins list and date.
export const CLOUDFLARE_RANGES_SOURCE_DATE = "2026-10-13";

export const CLOUDFLARE_IPV4 = Object.freeze([
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
]);

export const CLOUDFLARE_IPV6 = Object.freeze([
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]);

/** Parse a dotted IPv4 to a BigInt, or null. */
function v4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0n;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = (n << 8n) | BigInt(o);
  }
  return n;
}

/** Parse an IPv6 (with :: and an optional trailing dotted quad) to a BigInt, or null. */
function v6(s) {
  if (!s.includes(":") || /[^0-9a-fA-F:.]/.test(s)) return null;
  let str = s;
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (tail) {
    const q = v4(tail[2]);
    if (q === null) return null;
    str = `${tail[1]}${((q >> 16n) & 0xffffn).toString(16)}:${(q & 0xffffn).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const groups = (p) => (p === "" ? [] : p.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = halves.length === 2 ? [...head, ...Array(fill).fill("0"), ...rest] : head;
  let n = 0n;
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(`0x${g}`);
  }
  return n;
}

/** Parse an IP to { bits, n }; an IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as the IPv4 address. */
export function parseIp(raw) {
  const s = String(raw ?? "").trim();
  const a = v4(s);
  if (a !== null) return { bits: 32, n: a };
  const b = v6(s);
  if (b === null) return null;
  if (b >> 32n === 0xffffn) return { bits: 32, n: b & 0xffffffffn };
  return { bits: 128, n: b };
}

const compile = (cidr) => {
  const [addr, len] = cidr.split("/");
  const ip = parseIp(addr);
  const shift = BigInt(ip.bits - Number(len));
  return { bits: ip.bits, prefix: ip.n >> shift, shift };
};
const COMPILED = [...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6].map(compile);

/** True when the address is a valid IP inside a committed Cloudflare range. */
export function isCloudflareIp(raw) {
  const ip = parseIp(raw);
  if (!ip) return false;
  return COMPILED.some((c) => c.bits === ip.bits && ip.n >> c.shift === c.prefix);
}
