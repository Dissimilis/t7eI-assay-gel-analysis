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
