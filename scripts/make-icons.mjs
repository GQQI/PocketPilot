import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "apps/web/public/icons");
mkdirSync(outDir, { recursive: true });
if (existsSync(path.join(outDir, "icon-192.png")) && existsSync(path.join(outDir, "icon-512.png"))) {
  console.log("icons exist (rendered from favicon.svg by scripts/make-web-icons.mjs)");
  process.exit(0);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function insideRound(x, y, size, radius) {
  const r = radius;
  const max = size - 1;
  if (x >= r && x <= max - r) return y >= 0 && y <= max;
  if (y >= r && y <= max - r) return x >= 0 && x <= max;
  const cx = x < r ? r : max - r;
  const cy = y < r ? r : max - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function paint(x, y, size) {
  if (!insideRound(x, y, size, size * 0.22)) return [0, 0, 0, 0];
  let color = [18, 17, 15, 255];
  const barX = size * 0.22;
  const barW = size * 0.11;
  if (x >= barX && x <= barX + barW && y >= size * 0.24 && y <= size * 0.76) color = [223, 242, 90, 255];
  const cx = size * 0.68;
  const cy = size * 0.36;
  const rad = size * 0.09;
  if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) color = [255, 122, 89, 255];
  return color;
}

function png(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = paint(x, y, size);
      const offset = y * stride + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(path.join(outDir, "icon-192.png"), png(192));
writeFileSync(path.join(outDir, "icon-512.png"), png(512));
console.log("wrote", outDir);
