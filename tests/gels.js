// Seeded random synthetic gels with known % editing, for the invariant tests.
'use strict';
const T = require('../js/analysis.js');

/** Small seeded generator (mulberry32): the same seed gives the same gels on every run. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (lo, hi) => Math.floor(next.range(lo, hi + 1));
  next.pick = arr => arr[Math.floor(next() * arr.length)];
  return next;
}

/**
 * A row of T7E1 lanes in the range the app is meant for: bands at least about five widths apart,
 * parent and products inside the box, an 8-bit image. Each lane has its own % editing, some 0.
 * Returns { img, box, truth: [% per lane], lanes: [{ x, bands }], products }.
 */
function t7Row(seed, opts) {
  const r = rng(seed), o = Object.assign({}, opts), hard = !!o.hard;
  const nLanes = o.lanes || r.int(4, 12), pitch = r.int(80, 110), sd = r.range(3, 5);
  const products = o.products || 2;
  // Hard gels: bands closer together, more noise, sloped background, dimers, wells, clipping.
  const gap = hard ? 4 : 6;
  const parentY = r.int(25, 40), off1 = r.int(Math.ceil(gap * sd), 40), off2 = off1 + r.int(Math.ceil(gap * sd), 45);
  const dimerY = parentY + (products === 2 ? off2 : off1) + r.int(14, 24);
  const h = dimerY + r.int(16, 30);
  const w = pitch * (nLanes + 1), bg = r.int(195, 220), amp = hard ? r.range(60, 230) : r.range(60, 110);
  const noise = hard ? r.range(0, 3) : r.range(0, 1.5), slope = hard ? r.range(-0.15, 0.15) : 0;
  const dimerLanes = hard && r() < 0.3, well = hard && r() < 0.2;
  const halfW = Math.round(0.35 * pitch);
  const lanes = [], truth = [];
  for (let i = 0; i < nLanes; i++) {
    const ed = r() < 0.15 ? 0 : r.range(3, hard ? 85 : 70), fc = 1 - (1 - ed / 100) ** 2;
    // Products split the cut DNA by length: the shorter fragment runs further and carries less dye.
    const share = r.range(0.55, 0.75);
    const bands = products === 2
      ? [[parentY, 1 - fc], [parentY + off1, fc * share], [parentY + off2, fc * (1 - share)]]
      : [[parentY, 1 - fc], [parentY + off1, fc]];
    if (dimerLanes && r() < 0.6) bands.push([dimerY, r.range(0.05, 0.3)]);
    if (well) bands.push([4, 0.4]);
    lanes.push({ x: Math.round(pitch * (i + 1)), bands });
    truth.push(ed);
  }
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = bg + slope * (y - h / 2);
  lanes.forEach(({ x, bands }) => {
    for (let y = 0; y < h; y++) {
      let v = 0;
      bands.forEach(([yc, m]) => { v += amp * m * Math.exp(-((y - yc) ** 2) / (2 * sd * sd)); });
      for (let xx = x - halfW; xx <= x + halfW; xx++) g[y * w + xx] -= v;
    }
  });
  for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, Math.round(g[i] + (r() - 0.5) * 2 * noise)));
  const top = well ? 1 : Math.max(1, parentY - r.int(12, 20));
  const box = { x0: Math.round(pitch / 2), x1: Math.round(pitch * (nLanes + 0.5)), y0: top, y1: h - 2 };
  let clipped = 0;
  for (let i = 0; i < g.length; i++) if (g[i] === 0) clipped++;
  const features = { gapSd: Math.min(off1, off2 - off1) / sd, noise, slope, dimer: dimerLanes, well, clipped: clipped > 0, amp };
  return { img: T.makeImage(g, w, h), box, truth, lanes, products, sd, dimer: dimerLanes ? dimerY : null, features };
}

/** Lanes found in the box, with optional per-lane overrides, analysed with the given parameters. */
function analyseRow(img, box, laneOf, params) {
  const sig = T.signalImage(img, 'dark');
  const d = T.detectLanes(sig, img, box);
  const lanes = d.xs.map((x, i) => Object.assign({ x, role: null }, laneOf ? laneOf(i, x) : {}));
  return T.analyze(img, [Object.assign({}, box, { pitch: d.pitch, lanes })], Object.assign({ polarity: 'dark' }, params)).rows[0];
}

module.exports = { rng, t7Row, analyseRow };
