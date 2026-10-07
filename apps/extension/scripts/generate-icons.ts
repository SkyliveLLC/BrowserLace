/**
 * Renders the toolbar icon (the mark in lib/mark.ts, also drawn by `Logo`) to PNGs in
 * public/icon. Dependency-free so it runs anywhere: `node scripts/generate-icons.ts`.
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { MARK, markWaves } from "../lib/mark.ts";

const ACCENT = [79, 70, 229];
const SIZES = [16, 32, 48, 96, 128];
const SAMPLES = 4;

const waves = markWaves().flat();

function color(x: number, y: number): [number, number, number, number] {
  const { size, radius: r, stroke } = MARK;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  if (x < 0 || y < 0 || x > size || y > size || Math.hypot(x - cx, y - cy) > r) return [0, 0, 0, 0];
  const onWave = waves.some(([wx, wy]) => Math.hypot(x - wx, y - wy) < stroke / 2);
  return onWave ? [255, 255, 255, 255] : [...ACCENT, 255] as [number, number, number, number];
}

function crc32(bytes: Uint8Array) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

for (const size of SIZES) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = color(((px + (sx + 0.5) / SAMPLES) / size) * MARK.size, ((py + (sy + 0.5) / SAMPLES) / size) * MARK.size);
          // Premultiply so edges blend instead of darkening.
          for (let k = 0; k < 3; k++) sum[k]! += c[k]! * c[3]!;
          sum[3]! += c[3]!;
        }
      }
      const offset = py * (size * 4 + 1) + 1 + px * 4;
      const alpha = sum[3]!;
      for (let k = 0; k < 3; k++) raw[offset + k] = alpha ? Math.round(sum[k]! / alpha) : 0;
      raw[offset + 3] = Math.round(alpha / SAMPLES ** 2);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
  writeFileSync(new URL(`../public/icon/${size}.png`, import.meta.url), png);
}
console.log(`Wrote ${SIZES.join(", ")}px icons`);
