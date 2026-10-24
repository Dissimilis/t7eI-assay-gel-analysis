'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TIFF = require('../js/tiff.js');

const dir = path.join(__dirname, 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));

function load(name) {
  const b = fs.readFileSync(path.join(dir, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

for (const name of ['gray8-raw.tif', 'gray8-lzw.tif', 'gray8-packbits.tif', 'gray8-deflate.tif', 'rgb8-lzw.tif']) {
  test('decodes ' + name, async () => {
    const img = await TIFF.decode(load(name));
    assert.equal(img.w, expected.w);
    assert.equal(img.h, expected.h);
    for (let i = 0; i < expected.g8.length; i++) {
      assert.ok(Math.abs(img.gray[i] - expected.g8[i]) < 0.6, `${name} pixel ${i}: ${img.gray[i]} vs ${expected.g8[i]}`);
    }
  });
}

for (const name of ['gray16-raw.tif', 'gray16-lzw.tif']) {
  test('decodes ' + name + ' keeping 16-bit precision', async () => {
    const img = await TIFF.decode(load(name));
    assert.equal(img.bits, 16);
    for (let i = 0; i < expected.g16.length; i++) {
      const want = expected.g16[i] * 255 / 65535;
      assert.ok(Math.abs(img.gray[i] - want) < 1e-3, `${name} pixel ${i}`);
    }
  });
}

test('rejects non-TIFF data', async () => {
  await assert.rejects(TIFF.decode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer), /Not a TIFF/);
});

test('12-bit data in a 16-bit file is scaled by its own range', async () => {
  const img = await TIFF.decode(load('gray12-in-16.tif'));
  assert.equal(img.bits, 12);
  let max = 0;
  for (const v of img.gray) max = Math.max(max, v);
  assert.ok(Math.abs(max - 3930 * 255 / 4095) < 1e-3, 'full scale is 4095, max ' + max);
});

test('rejects palette TIFF instead of reading colour indices as grey values', async () => {
  await assert.rejects(TIFF.decode(load('palette.tif')), /palette/);
});

test('rejects a truncated TIFF instead of filling the rest with zeros', async () => {
  await assert.rejects(TIFF.decode(load('gray8-truncated.tif')), /truncated|damaged/);
});

test('rejects huge declared dimensions before allocating', async () => {
  // Little-endian header, one IFD with width = height = 30000 and a 1-byte strip.
  const entries = [[256, 4, 1, 30000], [257, 4, 1, 30000], [258, 3, 1, 8], [273, 4, 1, 8], [279, 4, 1, 1]];
  const b = Buffer.alloc(10 + entries.length * 12 + 4);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    b.writeUInt16LE(tag, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(count, o + 4);
    if (type === 3) b.writeUInt16LE(value, o + 8); else b.writeUInt32LE(value, o + 8);
  });
  await assert.rejects(TIFF.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), /megapixels/);
});

test('a clipped 12-bit band in a left-aligned 16-bit file counts as saturated', async () => {
  const img = await TIFF.decode(load('clip12-left.tif'));
  const w = img.w;
  assert.ok(img.gray[15 * w + 40] >= img.clipHigh, 'pile at the ceiling is clipped');
  assert.ok(img.gray[30 * w + 100] < img.clipHigh, 'ordinary pixels are not');
});

test('8-bit values in a 16-bit file keep their 8-bit scale', async () => {
  // Uncompressed 16-bit grey, values 0-255 only: background 200 with a darker band.
  const w = 40, h = 30, data = 8 + 2 + 9 * 12 + 4;
  const entries = [[256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 16], [259, 3, 1, 1], [262, 3, 1, 1],
    [273, 4, 1, data], [277, 3, 1, 1], [278, 3, 1, h], [279, 4, 1, w * h * 2]];
  const b = Buffer.alloc(data + w * h * 2);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    b.writeUInt16LE(tag, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(count, o + 4);
    if (type === 3) b.writeUInt16LE(value, o + 8); else b.writeUInt32LE(value, o + 8);
  });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.writeUInt16LE(y >= 10 && y < 15 ? 90 : 200, data + 2 * (y * w + x));
  const img = await TIFF.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  assert.equal(img.bits, 8);
  assert.equal(img.storedBits, 16);
  assert.ok(Math.abs(img.gray[0] - 200) < 1e-3 && Math.abs(img.gray[12 * w] - 90) < 1e-3, `grey ${img.gray[0]}, ${img.gray[12 * w]}`);
});

test('an opaque alpha channel does not set the range of 12-bit RGB data', async () => {
  // Uncompressed 16-bit RGBA: grey RGB values up to 4095, alpha 65535 everywhere.
  const w = 40, h = 30, ne = 11, data = 8 + 2 + ne * 12 + 4, bpsAt = data + w * h * 8;
  const entries = [[256, 3, 1, w], [257, 3, 1, h], [258, 3, 4, bpsAt], [259, 3, 1, 1], [262, 3, 1, 2],
    [273, 4, 1, data], [277, 3, 1, 4], [278, 3, 1, h], [279, 4, 1, w * h * 8], [284, 3, 1, 1], [338, 3, 1, 2]];
  const b = Buffer.alloc(bpsAt + 8);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    b.writeUInt16LE(tag, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(count, o + 4);
    if (type === 3 && count === 1) b.writeUInt16LE(value, o + 8); else b.writeUInt32LE(value, o + 8);
  });
  for (let k = 0; k < 4; k++) b.writeUInt16LE(16, bpsAt + 2 * k);
  for (let p = 0; p < w * h; p++) {
    const v = Math.floor(p / w) >= 10 && Math.floor(p / w) < 15 ? 1000 : 4095;
    for (let c = 0; c < 3; c++) b.writeUInt16LE(v, data + 8 * p + 2 * c);
    b.writeUInt16LE(65535, data + 8 * p + 6);
  }
  const img = await TIFF.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  assert.equal(img.bits, 12);
  assert.ok(Math.abs(img.gray[0] - 255) < 0.5, 'white maps to full scale, got ' + img.gray[0]);
});

test('NaN samples in a float TIFF read as background and do not set the range', async () => {
  const w = 20, h = 10, ne = 10, data = 8 + 2 + ne * 12 + 4;
  const entries = [[256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 32], [259, 3, 1, 1], [262, 3, 1, 1],
    [273, 4, 1, data], [277, 3, 1, 1], [278, 3, 1, h], [279, 4, 1, w * h * 4], [339, 3, 1, 3]];
  const b = Buffer.alloc(data + w * h * 4);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    b.writeUInt16LE(tag, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(count, o + 4);
    if (type === 3) b.writeUInt16LE(value, o + 8); else b.writeUInt32LE(value, o + 8);
  });
  for (let p = 0; p < w * h; p++) b.writeFloatLE(p === 5 ? NaN : p === 6 ? Infinity : (p % w) / (w - 1), data + 4 * p);
  const img = await TIFF.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  assert.ok(img.gray.every(Number.isFinite), 'all grey values finite');
  assert.ok(Math.abs(img.gray[w - 1] - 255) < 1e-3, 'range from the finite samples: ' + img.gray[w - 1]);
});
