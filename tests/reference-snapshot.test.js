// Every lane of the local reference gels, compared with a saved snapshot: no % editing, role or
// warning may change without the snapshot being updated on purpose. The gels and the snapshot
// (reference/snapshot.json) are local lab material and stay out of the repository.
// After an intended change: T7E1_UPDATE_SNAPSHOT=1 npm test, then review the git-ignored diff.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../js/analysis.js');
const TIFF = require('../js/tiff.js');

const dir = path.join(__dirname, '..', 'reference');
const snapFile = path.join(dir, 'snapshot.json');

// The imager-exported gels, plus the ImageJ-validated E-Gel photo when T7E1_GEL_PGM points at it.
const JOBS = [
  ['IM002717', 'gel-IM002717.tif', { x0: 580, x1: 1640, y0: 640, y1: 790 }],
  ['UVP10523 top', 'gel-UVP10523.tif', { x0: 20, x1: 1340, y0: 330, y1: 470 }],
  ['UVP10523 bottom', 'gel-UVP10523.tif', { x0: 20, x1: 1340, y0: 720, y1: 870 }],
  ['UVP07853 top', 'gel-UVP07853.tif', { x0: 100, x1: 1280, y0: 350, y1: 472 }],
  ['UVP07853 bottom', 'gel-UVP07853.tif', { x0: 100, x1: 1100, y0: 690, y1: 845 }],
  ['IM002286 row 1', 'pgm', { x0: 430, x1: 1230, y0: 505, y1: 625 }],
  ['IM002286 row 2', 'pgm', { x0: 430, x1: 975, y0: 880, y1: 1000 }],
  // The 200 bp product sits on a smear; the box ends just under it (gel-IM003690.pgm: the photo's luma)
  ['IM003690 bottom', 'gel-IM003690.pgm', { x0: 480, x1: 1260, y0: 914, y1: 1105 }]
];

const cache = {};
async function image(file) {
  if (cache[file]) return cache[file];
  if (file === 'pgm' || /\.pgm$/.test(file)) {
    const b = fs.readFileSync(file === 'pgm' ? process.env.T7E1_GEL_PGM : path.join(dir, file));
    const hd = b.slice(0, 32).toString('latin1').split(/\s+/), w = +hd[1], h = +hd[2];
    return (cache[file] = T.makeImage(Float32Array.from(b.slice(b.length - w * h)), w, h));
  }
  const b = fs.readFileSync(path.join(dir, file));
  const t = await TIFF.decode(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  return (cache[file] = T.makeImage(t.gray, t.w, t.h, t));
}
const present = file => (file === 'pgm' ? !!process.env.T7E1_GEL_PGM && fs.existsSync(process.env.T7E1_GEL_PGM) : fs.existsSync(path.join(dir, file)));

async function results() {
  const out = {};
  for (const [name, file, box] of JOBS) {
    if (!present(file)) continue;
    const img = await image(file), pol = T.detectPolarity(img), sig = T.signalImage(img, pol), d = T.detectLanes(sig, img, box);
    for (const background of ['valley', 'blend', 'envelope']) {
      const row = T.analyze(img, [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null })) })], { polarity: pol, background }, sig).rows[0];
      out[name + ' / ' + background] = row.lanes.map(l => ({
        x: Math.round(l.x), role: l.role, editing: Number.isFinite(l.editing) ? +l.editing.toFixed(2) : null,
        peaks: l.peaks.map(y => y + l.y0), flags: l.flags.slice().sort()
      }));
    }
  }
  return out;
}

test('reference gels: every lane matches the saved snapshot', { skip: !JOBS.some(j => present(j[1])) && 'no reference gels here' }, async () => {
  const now = await results();
  if (process.env.T7E1_UPDATE_SNAPSHOT || !fs.existsSync(snapFile)) {
    const old = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : {};
    fs.writeFileSync(snapFile, JSON.stringify(Object.assign(old, now), null, 1) + '\n');
    return;
  }
  const saved = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const diffs = [];
  for (const [key, lanes] of Object.entries(now)) {
    if (!saved[key]) { diffs.push(`${key}: not in the snapshot`); continue; }
    lanes.forEach((l, i) => {
      const s = saved[key][i];
      if (JSON.stringify(l) !== JSON.stringify(s)) diffs.push(`${key} lane ${i}: ${JSON.stringify(s)} -> ${JSON.stringify(l)}`);
    });
    if (saved[key].length !== lanes.length) diffs.push(`${key}: ${saved[key].length} lanes -> ${lanes.length}`);
  }
  assert.deepEqual(diffs, [], 'results changed; if intended, run with T7E1_UPDATE_SNAPSHOT=1');
});
