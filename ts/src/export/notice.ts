import { crc32 } from "node:zlib";

/** PNG iTXt stores UTF-8 without lossy Latin-1 conversion; the CRC covers type and payload. */
export function withPngNotice(png: Uint8Array, notice: string): Uint8Array {
  const data = Buffer.from(`Copyright\0\0\0\0\0${notice}`, "utf8");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write("iTXt", 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  // The renderer emits a complete PNG ending in the fixed zero-length IEND chunk.
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}
