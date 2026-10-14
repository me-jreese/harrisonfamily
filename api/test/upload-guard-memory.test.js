// HFY-TSK-240 review: a small upload whose compressed XMP claims hundreds of MB must not make the Lambda (256 MB) inflate it.
// Every inflate in upload-guard.js is capped by maxOutputLength, so no call can return more than XMP_MAX_INFLATED in all.
import { describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] }));
vi.mock("node:zlib", async (importOriginal) => {
  const z = await importOriginal();
  return {
    ...z,
    inflateSync(buf, opts) {
      const call = { maxOutputLength: opts?.maxOutputLength };
      calls.push(call);
      try {
        const out = z.inflateSync(buf, opts);
        call.out = out.length;
        return out;
      } catch (e) {
        call.threw = e.code;
        throw e;
      }
    },
  };
});

const { XMP_MAX_INFLATED, findLocation } = await import("../src/upload-guard.js");
const { png } = await import("./photo-fixtures.js");

describe("compressed XMP is inflated under a cap", () => {
  it("a 64 MiB XMP bomb inside the first 256 KiB stops at XMP_MAX_INFLATED and is refused", () => {
    const bomb = png({ xmp: `xmlns:exif ${"A".repeat(64 * 1024 * 1024)}`, compressXmp: true });
    expect(bomb.length).toBeLessThan(262144);
    calls.length = 0;
    expect(findLocation(bomb)).toBe("xmp_location");
    expect(calls).toHaveLength(1);
    expect(calls[0].maxOutputLength).toBeLessThanOrEqual(XMP_MAX_INFLATED);
    expect(calls[0].threw).toBe("ERR_BUFFER_TOO_LARGE");
  });
  it("chunks under the cap share one budget", () => {
    const small = png({ xmp: `xmlns:exif ${" ".repeat(600 * 1024)}`, compressXmp: true });
    const itxt = small.subarray(33, small.length - 12 - 21);
    const three = Uint8Array.from([...small.subarray(0, 33), ...itxt, ...itxt, ...itxt, ...small.subarray(small.length - 33)]);
    calls.length = 0;
    expect(findLocation(three)).toBe("xmp_location");
    expect(calls.reduce((n, c) => n + (c.out ?? 0), 0)).toBeLessThanOrEqual(XMP_MAX_INFLATED);
    expect(calls.map((c) => c.maxOutputLength)).toEqual([XMP_MAX_INFLATED, XMP_MAX_INFLATED - calls[0].out]);
  });
});
