'use strict';
// Generates build/icon.png and src/icon.png (512x512) without image dependencies:
// a dark rounded tile with three agent-coloured tab strips and a terminal prompt.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const px = new Float32Array(S * S * 4);

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function blend(x, y, rgb, a) {
  if (a <= 0) return;
  const i = (y * S + x) * 4;
  const da = px[i + 3];
  const oa = a + da * (1 - a);
  for (let k = 0; k < 3; k++) px[i + k] = (rgb[k] * a + px[i + k] * da * (1 - a)) / (oa || 1);
  px[i + 3] = oa;
}

// Signed distance to a rounded rectangle.
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(x, y, ax, ay, bx, by) {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function shape(sd, rgb) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = sd(x + 0.5, y + 0.5);
      blend(x, y, rgb, clamp(0.5 - d, 0, 1));
    }
  }
}

// Tile
shape((x, y) => sdRoundRect(x, y, 256, 256, 236, 236, 96), hex('#1a1d23'));
shape((x, y) => sdRoundRect(x, y, 256, 290, 196, 158, 40), hex('#0f1115'));
// Tab strips
const tabs = [['#d97757', 116], ['#10a37f', 256], ['#7c8cff', 396]];
for (const [c, cx] of tabs) shape((x, y) => sdRoundRect(x, y, cx, 102, 58, 22, 14), hex(c));
// Prompt chevron and cursor
shape((x, y) => Math.min(sdSegment(x, y, 150, 220, 230, 290), sdSegment(x, y, 230, 290, 150, 360)) - 22, hex('#e9ecf1'));
shape((x, y) => sdRoundRect(x, y, 318, 360, 60, 20, 10), hex('#e9ecf1'));

// Encode PNG
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const o = y * (S * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(px[i]);
    raw[o + 1] = Math.round(px[i + 1]);
    raw[o + 2] = Math.round(px[i + 2]);
    raw[o + 3] = Math.round(px[i + 3] * 255);
  }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png);
fs.writeFileSync(path.join(root, 'src', 'icon.png'), png);
console.log('icon written', png.length, 'bytes');
