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
