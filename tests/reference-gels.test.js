// Regression against real gel photos kept outside the repository (reference/ is git-ignored).
// Each test is skipped when its image is not present.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../js/analysis.js');
const TIFF = require('../js/tiff.js');

const ref = name => path.join(__dirname, '..', 'reference', name);

async function load(name) {
  const b = fs.readFileSync(ref(name));
  const t = await TIFF.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  return T.makeImage(t.gray, t.w, t.h, t);
}

function analyse(img, box, overrides) {
  const pol = T.detectPolarity(img), sig = T.signalImage(img, pol);
  const d = T.detectLanes(sig, img, box);
  const lanes = d.xs.map((x, i) => ({ x, role: null, bands: (overrides && overrides[i]) || null }));
  return T.analyze(img, [Object.assign({}, box, { pitch: d.pitch, lanes })], { polarity: pol }).rows[0];
}

// Parent and product positions (absolute y) read lane by lane from the image, for the lanes with a clear
// cleavage pattern. Keys are lane indices in the box (0 is the ladder).
const UVP10523 = {
  top: { box: { x0: 20, x1: 1340, y0: 330, y1: 470 }, lanes: {
    1: [384, 416, 448], 2: [384, 416, 447], 4: [391, 426, 446], 5: [392, 427, 446], 11: [382, 414, 439],
    12: [383, 415, 440], 13: [382, 411, 442], 16: [380, 409, 439], 18: [371, 397, 438], 19: [371, 396, 438], 21: [373, 397, 441] } },
  bottom: { box: { x0: 20, x1: 1340, y0: 720, y1: 870 }, lanes: {
    1: [767, 799, 845], 2: [769, 800, 844], 3: [768, 800, 842], 4: [768, 800, 842], 5: [769, 800, 842], 6: [768, 801, 842],
    8: [770, 808, 839], 9: [772, 809, 842], 15: [765, 799, 832], 16: [763, 797, 830] } }
};

test('UVP10523: clear lanes get the right parent and products (rows mix amplicons)', { skip: !fs.existsSync(ref('gel-UVP10523.tif')) }, async () => {
  const img = await load('gel-UVP10523.tif');
  for (const [name, row] of Object.entries(UVP10523)) {
    const res = analyse(img, row.box);
    assert.equal(res.lanes[0].role, 'marker', name + ' ladder');
    for (const [i, want] of Object.entries(row.lanes)) {
      const l = res.lanes[+i];
      const got = l.peaks.map(y => y + l.y0);
      want.forEach((y, k) => assert.ok(Math.abs(got[k] - y) <= 3, `${name} lane ${i}: bands ${got} vs ${want}`));
    }
  }
});

test('UVP10523: removing the extra band in lane 14 restores the expected products', { skip: !fs.existsSync(ref('gel-UVP10523.tif')) }, async () => {
  const img = await load('gel-UVP10523.tif');
  const res = analyse(img, UVP10523.top.box, { 14: { parent: null, products: [null, null], removed: [426] } });
  const l = res.lanes[14];
  const got = l.peaks.map(y => y + l.y0);
  [381, 411, 442].forEach((y, k) => assert.ok(Math.abs(got[k] - y) <= 3, `lane 14: ${got}`));
  assert.ok(l.flags.includes('manual band assignment'));
  // A band removed in one lane does not change the others.
  const auto = analyse(img, UVP10523.top.box);
  res.lanes.forEach((x, i) => { if (i !== 14) assert.deepEqual([x.editing, x.peaks], [auto.lanes[i].editing, auto.lanes[i].peaks], 'lane ' + i); });
});

test('IM002717: faint products next to clipped parents are found', { skip: !fs.existsSync(ref('gel-IM002717.tif')) }, async () => {
  const res = analyse(await load('gel-IM002717.tif'), { x0: 580, x1: 1640, y0: 640, y1: 790 });
  assert.equal(res.lanes[0].role, 'marker');
  res.lanes.slice(1, 10).forEach((l, i) => assert.deepEqual(l.found, [true, true, true], `lane ${i + 1}`));
  assert.equal(res.lanes[10].editing, 0, 'uncut control');
});
