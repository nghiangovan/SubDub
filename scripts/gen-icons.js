// Generates icons/icon{16,48,128}.png with Node stdlib only. Run: node scripts/gen-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.22;
  const inRound = (x, y) => {
    const dx = Math.max(r - x, 0, x - (size - 1 - r));
    const dy = Math.max(r - y, 0, y - (size - 1 - r));
    return dx * dx + dy * dy <= r * r;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRound(x, y)) continue; // transparent
      let col = [21, 101, 192]; // blue
      // play triangle
      const cx = size * 0.5, cy = size * 0.4, h = size * 0.26;
      const tx = (x - (cx - h * 0.55)) / (h * 1.5);
      if (tx >= 0 && tx <= 1 && Math.abs(y - cy) <= h * (1 - tx)) col = [255, 255, 255];
      // subtitle bars
      const barY = (y - size * 0.72) / (size * 0.07);
      if (barY >= 0 && barY < 1 && x >= size * 0.2 && x <= size * 0.8) col = [255, 255, 255];
      const bar2 = (y - size * 0.84) / (size * 0.06);
      if (bar2 >= 0 && bar2 < 1 && x >= size * 0.32 && x <= size * 0.68) col = [187, 222, 251];
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const s of [16, 48, 128]) fs.writeFileSync(path.join(dir, `icon${s}.png`), render(s));
console.log('icons generated');
