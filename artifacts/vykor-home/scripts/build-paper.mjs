import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

// A small, tileable plaster texture derived from the saved design seed. No downloaded image.
const size = 480;
const seed = 1155377807;
function hash(x, y) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function noise(x, y, cells) {
  const sx = x / size * cells, sy = y / size * cells;
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const fx = sx - ix, fy = sy - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const sample = (dx, dy) => hash((ix + dx + cells) % cells, (iy + dy + cells) % cells);
  const a = sample(0, 0) * (1 - u) + sample(1, 0) * u;
  const b = sample(0, 1) * (1 - u) + sample(1, 1) * u;
  return a * (1 - v) + b * v;
}
function height(x, y) {
  return noise(x, y, 12) * .35 + noise(x, y, 40) * .35 + noise(x, y, 120) * .3;
}
const pixels = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) {
  const row = y * (size * 4 + 1);
  pixels[row] = 0;
  for (let x = 0; x < size; x++) {
    const slope = (height((x + 1) % size, y) - height(x, (y + 1) % size)) * 3;
    const fiber = (hash(x, y) - .5) * .6;
    const light = slope + fiber;
    const offset = row + 1 + x * 4;
    const ink = light > 0 ? [255, 255, 251] : [83, 77, 67];
    pixels[offset] = ink[0]; pixels[offset + 1] = ink[1]; pixels[offset + 2] = ink[2];
    pixels[offset + 3] = Math.round(Math.min(17, Math.abs(light) * 25));
  }
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const kind = Buffer.from(name);
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length, 0);
  kind.copy(result, 4); bytes.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([kind, bytes])), bytes.length + 8);
  return result;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
header[8] = 8; header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const destination = new URL('../public/media/paper-grain.png', import.meta.url);
await writeFile(destination, png);
console.log(`Paper texture: ${size} × ${size}, ${png.length} bytes, seed ${seed}.`);
