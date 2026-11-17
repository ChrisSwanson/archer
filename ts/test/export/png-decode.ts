import { expect } from "vitest";
import { inflateSync } from "node:zlib";
/** Decode standard RGBA PNG scanlines to inspect the actual exported bytes. */
export function rgba(png: Uint8Array): {
  width: number;
  height: number;
  pixels: Uint8Array;
} {
  const data = Buffer.from(png),
    width = data.readUInt32BE(16),
    height = data.readUInt32BE(20),
    parts: Buffer[] = [];
  expect(data[24]).toBe(8);
  expect(data[25]).toBe(6);
  for (let at = 8; at < data.length; ) {
    const length = data.readUInt32BE(at),
      type = data.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") parts.push(data.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(parts)),
    pixels = new Uint8Array(width * height * 4),
    stride = width * 4;
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c,
      da = Math.abs(p - a),
      db = Math.abs(p - b),
      dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x,
        left = x < 4 ? 0 : pixels[at - 4]!,
        up = y ? pixels[at - stride]! : 0,
        corner = y && x >= 4 ? pixels[at - stride - 4]! : 0,
        base =
          filter === 0
            ? 0
            : filter === 1
              ? left
              : filter === 2
                ? up
                : filter === 3
                  ? Math.floor((left + up) / 2)
                  : paeth(left, up, corner);
      pixels[at] = (raw[y * (stride + 1) + 1 + x]! + base) & 255;
    }
  }
  return { width, height, pixels };
}
