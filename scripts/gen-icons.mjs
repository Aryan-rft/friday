// Generates PWA icons (PNG) with zero dependencies: raw RGBA → zlib → PNG chunks.
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "icons");
fs.mkdirSync(outDir, { recursive: true });

// ── PNG encoding ─────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ── Icon renderer ────────────────────────────────────────────────────────────
// Rounded dark square + gradient dot + face (two eyes + smile arc).
function renderIcon(size, maskable = false) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = maskable ? size * 0.42 : size * 0.22; // corner radius
  const bg = maskable ? [0x0b, 0x0f, 0x17] : [0x0b, 0x0f, 0x17];
  const safe = maskable ? 0.78 : 1.0; // content scale for safe zone

  const setPx = (x, y, cr, cg, cb, ca) => {
    const i = (y * size + x) * 4;
    rgba[i] = cr;
    rgba[i + 1] = cg;
    rgba[i + 2] = cb;
    rgba[i + 3] = ca;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rounded-rect background
      const cx = Math.min(x, size - 1 - x);
      const cy = Math.min(y, size - 1 - y);
      const insideCorner = cx >= r || cy >= r || distOK(cx, cy, r);
      if (!insideCorner) {
        setPx(x, y, 0, 0, 0, 0);
        continue;
      }
      // subtle diagonal gradient background
      const g = (x + y) / (2 * size);
      let rr = bg[0] + g * 14;
      let gg = bg[1] + g * 16;
      let bb = bg[2] + g * 26;

      // gradient dot (top-left-ish)
      const dotC = { x: size * 0.5, y: size * 0.34 };
      const dotR = size * 0.13 * safe;
      const dd = Math.hypot(x - dotC.x, y - dotC.y);
      if (dd < dotR) {
        const t = dd / dotR;
        rr = Math.round(109 + t * 96);
        gg = Math.round(141 - t * 16);
        bb = Math.round(255 - t * 56);
      }
      // eyes
      const eyeY = size * 0.52;
      for (const ex of [size * 0.38, size * 0.62]) {
        if (Math.hypot(x - ex, y - eyeY) < size * 0.035 * safe + 0.6) {
          rr = 231; gg = 236; bb = 245;
        }
      }
      // smile: arc centered below eyes
      const smileC = { x: size * 0.5, y: size * 0.52 };
      const smileR = size * 0.16 * safe;
      const sd = Math.hypot(x - smileC.x, y - smileC.y);
      if (sd > smileR - size * 0.022 && sd < smileR + size * 0.022 && y > eyeY + size * 0.02) {
        rr = 231; gg = 236; bb = 245;
      }
      setPx(x, y, Math.round(rr), Math.round(gg), Math.round(bb), 255);
    }
  }

  function distOK(px, py, rad) {
    const dx = rad - px;
    const dy = rad - py;
    return dx * dx + dy * dy <= rad * rad;
  }
  return encodePNG(size, size, rgba);
}

fs.writeFileSync(path.join(outDir, "icon-192.png"), renderIcon(192));
fs.writeFileSync(path.join(outDir, "icon-512.png"), renderIcon(512));
fs.writeFileSync(path.join(outDir, "icon-maskable-512.png"), renderIcon(512, true));
console.log("icons written to public/icons/");
