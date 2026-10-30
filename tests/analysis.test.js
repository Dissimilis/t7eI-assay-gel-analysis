// Run with: node --test "tests/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('../js/analysis.js');
const S = require('../js/sample.js');

test('Guschin formula: known points', () => {
  assert.equal(T.editingGuschin(0), 0);
  assert.ok(Math.abs(T.editingGuschin(0.75) - 50) < 1e-9);
  assert.ok(Math.abs(T.editingGuschin(1 - 0.8 * 0.8) - 20) < 1e-9);
});

test('single-allele formula: fc = 2p(1-p), invalid above 0.5', () => {
  assert.ok(Math.abs(T.editingSingle(2 * 0.3 * 0.7) - 30) < 1e-9);
  assert.ok(Math.abs(T.editingSingle(0.5) - 50) < 1e-9);
  assert.ok(Number.isNaN(T.editingSingle(0.6)));
});

function analyseSample(params) {
  const s = S.generate(7);
  const img = T.makeImage(s.gray, s.w, s.h);
  const polarity = T.detectPolarity(img);
  const sig = T.signalImage(img, polarity);
  const rows = s.rows.map(r => {
    const d = T.detectLanes(sig, img, r);
    return { x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null })) };
  });
  return { s, polarity, rows, res: T.analyze(img, rows, Object.assign({ polarity }, params)) };
}

test('sample gel: polarity, lanes and marker detection', () => {
  const { s, polarity, rows, res } = analyseSample();
  assert.equal(polarity, 'dark');
  s.rows.forEach((truth, ri) => {
    assert.equal(rows[ri].lanes.length, truth.lanes.length, 'lane count, row ' + ri);
    truth.lanes.forEach((t, i) => assert.ok(Math.abs(rows[ri].lanes[i].x - t.x) <= 4, `lane x row ${ri} lane ${i}`));
    assert.equal(res.rows[ri].lanes[0].role, 'marker', 'ladder recognised, row ' + ri);
  });
});

test('sample gel: % editing within 2 points of truth, mean error below 0.8', () => {
  const { s, res } = analyseSample();
  const errs = [];
  s.rows.forEach((truth, ri) => truth.lanes.forEach((t, i) => {
    if (t.role === 'marker' || t.tag === 'saturated') return;
    const l = res.rows[ri].lanes[i];
    const tol = t.tag === 'weak' ? 3 : 2;   // a weak lane is dominated by smear and noise
    if (!t.tag) errs.push(Math.abs(l.editing - t.editing));
    assert.ok(Math.abs(l.editing - t.editing) <= tol, `row ${ri} lane ${i}: ${l.editing.toFixed(2)} vs ${t.editing}`);
  }));
  const mae = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(mae < 0.8, 'mean absolute error ' + mae.toFixed(2));
});

test('sample gel: saturated parent is flagged, NC lanes read near zero', () => {
  const { s, res } = analyseSample();
  s.rows.forEach((truth, ri) => truth.lanes.forEach((t, i) => {
    const l = res.rows[ri].lanes[i];
    if (t.tag === 'saturated') assert.ok(l.flags.includes('parent saturated'));
    else assert.ok(!l.flags.includes('parent saturated'), `row ${ri} lane ${i} not saturated`);
    if (t.tag === 'nc') assert.ok(l.editing < 1, `NC row ${ri} lane ${i}: ${l.editing}`);
  }));
});

test('sample gel: every background method stays close on clean lanes', () => {
  for (const background of ['valley', 'blend', 'envelope']) {
    const { s, res } = analyseSample({ background });
    s.rows.forEach((truth, ri) => truth.lanes.forEach((t, i) => {
      if (t.role !== 'sample' || t.tag) return;
      const e = res.rows[ri].lanes[i].editing;
      assert.ok(Math.abs(e - t.editing) <= 3, `${background} row ${ri} lane ${i}: ${e.toFixed(2)} vs ${t.editing}`);
    }));
  }
});

test('manual valleys override the automatic ones', () => {
  const { rows } = analyseSample();
  const s = S.generate(7);
  const img = T.makeImage(s.gray, s.w, s.h);
  const auto = T.analyze(img, rows, { polarity: 'dark' }).rows[0].lanes[1];
  const v = auto.valleys.map(i => i + auto.y0);
  v[1] = auto.y0 + auto.peaks[0] + 4;   // into the parent's lower flank: a boundary only bounds a band, so it must pass the band's foot to change the area
  const lanes = rows[0].lanes.map((l, i) => i === 1 ? Object.assign({}, l, { valleys: v }) : l);
  const manual = T.analyze(img, [Object.assign({}, rows[0], { lanes })], { polarity: 'dark' }).rows[0].lanes[1];
  assert.ok(manual.flags.includes('manual band boundaries'));
  assert.notEqual(manual.areas[0], auto.areas[0]);
});

// Optional regression against a real E-Gel photo with hand ImageJ values.
// Set T7E1_GEL_PGM to an 8-bit binary PGM of the reference gel to run it.
const pgm = process.env.T7E1_GEL_PGM;
test('real gel: agreement with hand ImageJ values', { skip: !pgm || !fs.existsSync(pgm) }, () => {
  const b = fs.readFileSync(pgm);
  const head = b.slice(0, 32).toString('latin1').split(/\s+/);
  const w = +head[1], h = +head[2];
  const img = T.makeImage(Float32Array.from(b.slice(b.length - w * h)), w, h);
  const sig = T.signalImage(img, 'dark');
  const regions = [{ x0: 430, x1: 1230, y0: 505, y1: 625 }, { x0: 430, x1: 975, y0: 880, y1: 1000 }];
  const rows = regions.map(r => {
    const d = T.detectLanes(sig, img, r);
    return Object.assign({}, r, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null })) });
  });
  const res = T.analyze(img, rows, { polarity: 'dark' });
  const ref = [
    [20.2, 15.3, 21.3, 21.0, 22.5, 17.3, 11.1, 21.6, 14.2, 19.5, 20.1, 16.2, 19.0, 16.9],
    [18, 20, 23, 22, 19, 25, 4]
  ];
  const limits = [2.5, 0.8];
  res.rows.forEach((r, ri) => {
    const samples = r.lanes.filter(l => l.role === 'sample');
    const d = ref[ri].map((v, i) => Math.abs(samples[i].editing - v));
    const mae = d.reduce((a, c) => a + c, 0) / d.length;
    assert.ok(mae <= limits[ri], `row ${ri} MAE ${mae.toFixed(2)}`);
    assert.equal(r.lanes[0].role, 'marker');
  });
});

// Synthetic lanes on a flat background: [x, % editing], Gaussian bands at y 30/60/95.
function laneGel(lanes, opts) {
  const o = Object.assign({ w: 500, h: 140, ladder: null, width: 17, amp: 80 }, opts);
  const g = new Float32Array(o.w * o.h).fill(200);
  const draw = (xc, bands) => {
    for (let x = xc - o.width; x <= xc + o.width; x++) for (let y = 0; y < o.h; y++) {
      let v = 0;
      bands.forEach(([yc, m, sd = 4]) => { v += o.amp * m * Math.exp(-((y - yc) ** 2) / (2 * sd * sd)); });
      g[y * o.w + x] -= v;
    }
  };
  lanes.forEach(([xc, ed]) => {
    const p = ed / 100, fc = 1 - (1 - p) ** 2;
    draw(xc, [[30, 1 - fc], [60, fc * 2 / 3], [95, fc / 3]]);
  });
  if (o.ladder) draw(o.ladder, [[20, 1], [45, 0.8], [75, 0.6], [110, 0.5]]);
  return T.makeImage(g, o.w, o.h);
}

function analyseBox(img, box) {
  const sig = T.signalImage(img, 'dark');
  const d = T.detectLanes(sig, img, box);
  return T.analyze(img, [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null })) })], { polarity: 'dark' }).rows[0];
}

test('high editing: a product brighter than the parent does not become the parent', () => {
  const lanes = [[60, 50], [160, 60], [260, 20], [360, 0]];
  const row = analyseBox(laneGel(lanes), { x0: 0, x1: 500, y0: 5, y1: 135 });
  lanes.forEach(([, ed], i) => {
    assert.equal(row.lanes[i].role, 'sample');
    assert.ok(Math.abs(row.lanes[i].editing - ed) < 1, `lane ${i}: ${row.lanes[i].editing} vs ${ed}`);
  });
});

test('lanes alternating bright and dim are all found', () => {
  // The autocorrelation of such a row peaks at twice the lane spacing.
  const w = 960, h = 140, g = new Float32Array(w * h).fill(200), xs = [108, 215, 330, 439, 553, 657, 771, 880];
  xs.forEach((xc, i) => {
    const amp = i % 2 ? 35 : 110;
    for (let x = xc - 36; x <= xc + 36; x++) for (let y = 0; y < h; y++) g[y * w + x] -= amp * (0.7 * Math.exp(-((y - 35) ** 2) / 32) + 0.3 * Math.exp(-((y - 70) ** 2) / 32));
  });
  const img = T.makeImage(g, w, h), box = { x0: 54, x1: 942, y0: 10, y1: 130 };
  const d = T.detectLanes(T.signalImage(img, 'dark'), img, box);
  assert.equal(d.xs.length, xs.length, `found ${d.xs}`);
  d.xs.forEach((x, i) => assert.ok(Math.abs(x - xs[i]) <= 3, `lane ${i}: ${x} vs ${xs[i]}`));
});

test('two-lane row: the ladder does not set the product positions', () => {
  const img = laneGel([[200, 22]], { ladder: 100 });
  const row = analyseBox(img, { x0: 50, x1: 250, y0: 5, y1: 135 });
  assert.equal(row.lanes.length, 2);
  assert.equal(row.lanes[0].role, 'marker');
  assert.ok(Math.abs(row.lanes[1].editing - 22) < 1, String(row.lanes[1].editing));
});

test('a single lane that fills a tight box is still found, once', () => {
  const img = laneGel([[100, 25]], { w: 200, width: 40 });
  const row = analyseBox(img, { x0: 0, x1: 200, y0: 5, y1: 135 });
  assert.equal(row.lanes.length, 1);
  assert.ok(Math.abs(row.lanes[0].editing - 25) < 1.5, String(row.lanes[0].editing));
});

test('a band shared by every lane at a wrong position is flagged, not silently counted', () => {
  const W = 900, H = 140, g = new Float32Array(W * H).fill(200);
  for (let i = 0; i < 8; i++) {
    const xc = 60 + i * 110, fc = i === 3 ? 0.4 : 0;
    const bands = [[30, 1 - fc], [60, fc * 2 / 3], [95, fc / 3], [78, 0.25]];
    for (let x = xc - 17; x <= xc + 17; x++) for (let y = 0; y < H; y++) {
      let v = 0;
      bands.forEach(([yc, m]) => { v += 80 * m * Math.exp(-((y - yc) ** 2) / 32); });
      g[y * W + x] -= v;
    }
  }
  const row = analyseBox(T.makeImage(g, W, H), { x0: 0, x1: W, y0: 5, y1: 135 });
  row.lanes.forEach((l, i) => {
    if (i === 3) return;
    const silent = l.editing > 2 && !l.flags.some(f => /only one|not detected/.test(f));
    assert.ok(!silent, `lane ${i}: ${l.editing.toFixed(1)} with flags ${l.flags.join('; ')}`);
  });
});

test('low editing next to a strong parent: the faint lower product is still found', () => {
  const lanes = [[60, 3], [160, 4], [260, 3], [360, 0]];
  const row = analyseBox(laneGel(lanes, { amp: 190 }), { x0: 0, x1: 500, y0: 5, y1: 135 });
  lanes.forEach(([, ed], i) => {
    const l = row.lanes[i];
    if (ed) assert.deepEqual(l.found, [true, true, true], `lane ${i} flags ${l.flags.join('; ')}`);
    assert.ok(Math.abs(l.editing - ed) < 0.5, `lane ${i}: ${l.editing} vs ${ed}`);
  });
});

// Release scenarios from the final reviews: a wrong number must never be silent.
const WARNING = { test: f => T.isWarning(f) };   // the app's own list of warning flags

function bandGel(lanes, opts) {
  const o = Object.assign({ w: 900, h: 170, amp: 80 }, opts);
  const g = new Float32Array(o.w * o.h).fill(200);
  lanes.forEach(({ x, bands }) => {
    for (let xx = x - 17; xx <= x + 17; xx++) for (let y = 0; y < o.h; y++) {
      let v = 0;
      bands.forEach(([yc, m, sd = 4]) => { v += o.amp * m * Math.exp(-((y - yc) ** 2) / (2 * sd * sd)); });
      g[y * o.w + xx] -= v;
    }
  });
  return T.makeImage(g, o.w, o.h);
}

function t7Bands(ed, extra) {
  const p = ed / 100, fc = 1 - (1 - p) ** 2;
  return [[30, 1 - fc], [60, fc * 2 / 3], [95, fc / 3]].concat(extra || []);
}

function assertNotSilent(row, truths, label) {
  row.lanes.forEach((l, i) => {
    if (truths[i] == null) return;
    const ok = l.role === 'sample' && Math.abs(l.editing - truths[i]) <= 2;
    const warned = l.flags.some(f => WARNING.test(f)) || l.role !== 'sample';
    assert.ok(ok || warned, `${label} lane ${i}: ${l.editing.toFixed(1)} vs ${truths[i]}, role ${l.role}, flags [${l.flags.join('; ')}]`);
  });
}

const fourLanes = (ed, extra) => [60, 160, 260, 360].map((x, i) => ({ x, bands: t7Bands(Array.isArray(ed) ? ed[i] : ed, extra) }));

test('wells inside the box are flagged, not reported as editing', () => {
  for (const m of [1, 0.4]) {
    const row = analyseBox(bandGel(fourLanes([0, 10, 20, 30], [[12, m]]), { w: 500 }), { x0: 0, x1: 500, y0: 5, y1: 135 });
    assert.ok(row.lanes.some(l => l.role === 'sample'), 'not every lane is a ladder');
    assertNotSilent(row, [0, 10, 20, 30], 'well mass ' + m);
  }
});

test('a shared extra band below or between the products is flagged', () => {
  const below = analyseBox(bandGel(fourLanes(20, [[130, 0.2]]), { w: 500 }), { x0: 0, x1: 500, y0: 5, y1: 160 });
  assertNotSilent(below, [20, 20, 20, 20], 'band below');
  const lanes = [60, 160, 260, 360, 460, 560, 660, 760].map(x => ({ x, bands: t7Bands(20, [[78, 0.4]]) }));
  const between = analyseBox(bandGel(lanes), { x0: 0, x1: 900, y0: 5, y1: 135 });
  assertNotSilent(between, lanes.map(() => 20), 'dimer between');
});

test('bands cut by the box edge are flagged', () => {
  const img = bandGel(fourLanes(25), { w: 500 });
  assertNotSilent(analyseBox(img, { x0: 0, x1: 500, y0: 25, y1: 140 }), [25, 25, 25, 25], 'top cut');
  for (const y1 of [100, 102, 103, 105, 110]) assertNotSilent(analyseBox(img, { x0: 0, x1: 500, y0: 5, y1 }), [25, 25, 25, 25], 'bottom cut at ' + y1);
  for (const y0 of [18, 22, 25]) assertNotSilent(analyseBox(img, { x0: 0, x1: 500, y0, y1: 140 }), [25, 25, 25, 25], 'top cut at ' + y0);
  // Tight at both ends: a short box must not hide the cut behind an inflated noise estimate.
  for (const [y0, y1] of [[11, 103], [21, 116], [20, 104]]) assertNotSilent(analyseBox(img, { x0: 0, x1: 500, y0, y1 }), [25, 25, 25, 25], `box ${y0}-${y1}`);
});

test('very high editing (70-80%) finds the faint parent above the products', () => {
  const row = analyseBox(bandGel(fourLanes([70, 75, 80, 70]), { w: 500 }), { x0: 0, x1: 500, y0: 5, y1: 135 });
  [70, 75, 80, 70].forEach((ed, i) => assert.ok(Math.abs(row.lanes[i].editing - ed) <= 2, `lane ${i}: ${row.lanes[i].editing} vs ${ed}`));
  const higher = analyseBox(bandGel(fourLanes([82, 84, 87, 82]), { w: 500 }), { x0: 0, x1: 500, y0: 5, y1: 135 });
  [82, 84, 87, 82].forEach((ed, i) => assert.ok(Math.abs(higher.lanes[i].editing - ed) <= 2, `lane ${i}: ${higher.lanes[i].editing} vs ${ed}`));
});

test('One-product mode with a faint parent above is flagged', () => {
  const p = 0.6, fc = 1 - (1 - p) ** 2;
  const lanes = [60, 160, 260, 360].map(x => ({ x, bands: [[30, 1 - fc], [75, fc]] }));
  const img = bandGel(lanes, { w: 500 });
  const sig = T.signalImage(img, 'dark');
  const box = { x0: 0, x1: 500, y0: 5, y1: 135 };
  const d = T.detectLanes(sig, img, box);
  const row = T.analyze(img, [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null })) })], { polarity: 'dark', products: 1 }).rows[0];
  assertNotSilent(row, [60, 60, 60, 60], 'one product');
});

test('noisy boxes cut a little into the parent tail are flagged (review cases)', () => {
  // Same gel as the cut tests plus Gaussian pixel noise sigma 2 (Mulberry32 seed 10, Box-Muller).
  const img = bandGel(fourLanes(25), { w: 500 });
  let a = 10;
  const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < img.gray.length; i++) img.gray[i] += 2 * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  for (const [y0, y1] of [[18, 126], [19, 140], [18, 132], [20, 114]]) {
    assertNotSilent(analyseBox(img, { x0: 0, x1: 500, y0, y1 }), [25, 25, 25, 25], `noisy box ${y0}-${y1}`);
  }
});

// Manual band choices: remove an extra band, choose products, choose the parent.
test('a removed band is neither picked as a product nor counted', () => {
  // Bands spread apart (parent 30, products 70 and 115) with an extra band at 92 between the products.
  const p = 0.2, fc = 1 - (1 - p) ** 2;
  const bandsWith = extra => [[30, 1 - fc], [70, fc * 2 / 3], [115, fc / 3]].concat(extra);
  const lanes = [60, 160, 260, 360].map(x => ({ x, bands: bandsWith([[92, 0.25]]) }));
  const img = bandGel(lanes, { w: 500 });
  const box = { x0: 0, x1: 500, y0: 5, y1: 150 };
  const auto = analyseBox(img, box);
  const sig = T.signalImage(img, 'dark');
  const d = T.detectLanes(sig, img, box);
  const rows = [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null, bands: { parent: null, products: [null, null], removed: [92] } })) })];
  const fixed = T.analyze(img, rows, { polarity: 'dark' }).rows[0];
  fixed.lanes.forEach((l, i) => {
    assert.ok(Math.abs(l.editing - 20) <= 1.5, `lane ${i}: ${l.editing.toFixed(2)} with the extra band removed (automatic ${auto.lanes[i].editing.toFixed(2)})`);
    assert.ok(l.flags.includes('manual band assignment'));
    assert.ok(l.segKinds.includes(-1), 'removed band has its own excluded segment');
  });
});

test('products and parent chosen by hand are used', () => {
  const p = 0.25, fc = 1 - (1 - p) ** 2;
  const lanes = [60, 160, 260, 360].map(x => ({ x, bands: [[30, 1 - fc], [70, fc * 2 / 3], [115, fc / 3], [92, 0.3]] }));
  const img = bandGel(lanes, { w: 500 });
  const box = { x0: 0, x1: 500, y0: 5, y1: 150 };
  const sig = T.signalImage(img, 'dark');
  const d = T.detectLanes(sig, img, box);
  const rows = [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null, bands: { parent: 30, products: [70, 115], removed: [92] } })) })];
  const res = T.analyze(img, rows, { polarity: 'dark' }).rows[0];
  res.lanes.forEach((l, i) => {
    assert.deepEqual(l.peaks.map(y => y + l.y0), [30, 70, 115], `lane ${i} bands`);
    assert.ok(Math.abs(l.editing - 25) <= 1.5, `lane ${i}: ${l.editing.toFixed(2)}`);
  });
});

test('removing the band taken as parent makes the next band the parent', () => {
  // A strong band above the real parent (for example a heteroduplex) is taken as parent until removed.
  const lanes = [60, 160, 260, 360].map(x => ({ x, bands: [[12, 0.9]].concat(t7Bands(20)) }));
  const img = bandGel(lanes, { w: 500 });
  const box = { x0: 0, x1: 500, y0: 2, y1: 135 };
  const sig = T.signalImage(img, 'dark');
  const d = T.detectLanes(sig, img, box);
  const rows = [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null, bands: { parent: null, products: [null, null], removed: [12] } })) })];
  const res = T.analyze(img, rows, { polarity: 'dark' }).rows[0];
  res.lanes.forEach((l, i) => {
    assert.equal(l.peaks[0] + l.y0, 30, `lane ${i} parent`);
    // The artefact is heavier than the parent and 18 px above it; its Gaussian estimate takes a little of the parent.
    assert.ok(Math.abs(l.editing - 20) <= 2, `lane ${i}: ${l.editing.toFixed(2)}`);
  });
});

test('a removed band just below the last product is not counted in it', () => {
  const p = 0.2, fc = 1 - (1 - p) ** 2;
  const lanes = [60, 160, 260, 360].map(x => ({ x, bands: [[30, 1 - fc], [70, fc * 2 / 3], [115, fc / 3], [135, 0.3]] }));
  const img = bandGel(lanes, { w: 500, h: 170 });
  const box = { x0: 0, x1: 500, y0: 5, y1: 165 };
  const sig = T.signalImage(img, 'dark');
  const d = T.detectLanes(sig, img, box);
  const rows = [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null, bands: { parent: null, products: [null, null], removed: [135] } })) })];
  const res = T.analyze(img, rows, { polarity: 'dark' }).rows[0];
  res.lanes.forEach((l, i) => {
    assert.deepEqual(l.peaks.map(y => y + l.y0), [30, 70, 115], `lane ${i} bands`);
    assert.ok(Math.abs(l.editing - 20) <= 1.5, `lane ${i}: ${l.editing.toFixed(2)}`);
  });
});

test('an extra band repeated in a lane group does not silently replace a product', () => {
  const A = [[30, 0.64], [70, 0.24], [115, 0.12]];
  const B = [[30, 0.64], [75, 0.24], [105, 0.12], [90, 0.15]];
  const lanes = ['A', 'B', 'B', 'A', 'A', 'B', 'A'].map((k, i) => ({ x: 60 + i * 110, bands: k === 'A' ? A : B }));
  const row = analyseBox(bandGel(lanes, { w: 840, h: 170 }), { x0: 0, x1: 840, y0: 5, y1: 160 });
  assertNotSilent(row, lanes.map(() => 20), 'grouped extra band');
});

test('using the automatic product 1 as product 2 does not give one band two roles', () => {
  const lanes = [60, 160, 260, 360].map(x => ({ x, bands: [[30, 0.64], [70, 0.24], [115, 0.12]] }));
  const img = bandGel(lanes, { w: 500, h: 170 });
  const box = { x0: 0, x1: 500, y0: 5, y1: 160 };
  const sig = T.signalImage(img, 'dark');
  const d = T.detectLanes(sig, img, box);
  const rows = [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null, bands: { parent: null, products: [null, 70], removed: [] } })) })];
  const res = T.analyze(img, rows, { polarity: 'dark' }).rows[0];
  res.lanes.forEach((l, i) => {
    // Only detected bands count; a product that is not detected only marks where it was expected.
    const ys = l.peaks.filter((_, k) => l.found[k]).map(y => y + l.y0);
    assert.equal(new Set(ys.map(y => Math.round(y / 4))).size, ys.length, `lane ${i}: distinct bands ${ys}`);
  });
  assertNotSilent(res, [20, 20, 20, 20], 'swapped product');
});

test('the last lane of a second amplicon is measured with its own pattern', () => {
  const A = t7Bands(15).map(([y, m]) => [y + 10, m]);   // 40, 70, 105
  const p = 0.4, fc = 1 - (1 - p) ** 2, B = [[40, 1 - fc], [90, fc * 2 / 3], [140, fc / 3]];
  const lanes = ['A', 'A', 'A', 'A', 'B', 'B'].map((k, i) => ({ x: 60 + i * 100, bands: k === 'A' ? A : B }));
  const row = analyseBox(bandGel(lanes, { w: 650, h: 175 }), { x0: 0, x1: 650, y0: 5, y1: 165 });
  [4, 5].forEach(i => {
    assert.equal(row.lanes[i].role, 'sample', 'lane ' + i);
    assert.ok(Math.abs(row.lanes[i].editing - 40) <= 2, `lane ${i}: ${row.lanes[i].editing}`);
  });
});

test('an extra band below the products in one lane does not move its parent', () => {
  const lanes = [60, 160, 260, 360, 460].map((x, i) => ({ x, bands: t7Bands(20, i === 2 ? [[125, 0.35]] : []) }));
  const row = analyseBox(bandGel(lanes, { w: 560 }), { x0: 0, x1: 560, y0: 5, y1: 160 });
  const l = row.lanes[2];
  assert.equal(l.peaks[0] + l.y0, 30, 'parent of lane 2');
  assertNotSilent(row, [20, 20, 20, 20, 20], 'one extra band');
});

test('One-product mode measures the end lanes too', () => {
  const lanes = [60, 160, 260, 360].map(x => ({ x, bands: [[30, 0.5625], [70, 0.2917], [115, 0.1458]] }));
  const img = bandGel(lanes, { w: 500 });
  const sig = T.signalImage(img, 'dark');
  const box = { x0: 0, x1: 500, y0: 5, y1: 160 };
  const d = T.detectLanes(sig, img, box);
  const row = T.analyze(img, [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null })) })], { polarity: 'dark', products: 1 }).rows[0];
  row.lanes.forEach((l, i) => assert.equal(l.role, 'sample', 'lane ' + i));
  assertNotSilent(row, [25, 25, 25, 25], 'one product');
});

function analyseWith(img, box, bandsOf) {
  const sig = T.signalImage(img, 'dark');
  const d = T.detectLanes(sig, img, box);
  return T.analyze(img, [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map((x, i) => ({ x, role: null, bands: bandsOf(i) })) })], { polarity: 'dark' }).rows[0];
}

test('a band chosen as a product is never also the automatic parent', () => {
  const img = bandGel(fourLanes(20), { w: 500 });
  const row = analyseWith(img, { x0: 0, x1: 500, y0: 5, y1: 135 }, i => (i === 1 ? { parent: null, products: [null, 30], removed: [] } : null));
  const l = row.lanes[1], ys = l.peaks.map(y => y + l.y0);
  assert.notEqual(ys[0], 30, 'parent');
  assertNotSilent(row, [20, 20, 20, 20], 'product chosen at the parent');
});

test('removing a band in a ladder-like lane does not change its neighbours', () => {
  const t70 = t7Bands(70).map(([y, m]) => [y === 30 ? 30 : y === 60 ? 70 : 115, m]);
  const lanes = [{ x: 60, bands: t70 }, { x: 160, bands: [[30, 0.8], [60, 0.16], [95, 0.16], [140, 0.16]] }, { x: 260, bands: t70 }];
  const img = bandGel(lanes, { w: 400, h: 190 }), box = { x0: 0, x1: 400, y0: 5, y1: 185 };
  const before = analyseWith(img, box, () => null), after = analyseWith(img, box, i => (i === 1 ? { parent: null, products: [null, null], removed: [30] } : null));
  [0, 2].forEach(i => assert.equal(after.lanes[i].editing, before.lanes[i].editing, 'lane ' + i));
});

test('a strong removed artefact above the parent: neither its flank nor its tail is measured', () => {
  const img = bandGel([{ x: 60, bands: [[20, 1.5]].concat(t7Bands(20).map(([y, m]) => [y + 20, m])) }], { w: 200, h: 190 });
  const box = { x0: 0, x1: 200, y0: 5, y1: 185 };
  for (const b of [{ parent: null, products: [null, null], removed: [20] }, { parent: 50, products: [80, 115], removed: [20] }]) {
    const l = analyseWith(img, box, () => b).lanes[0];
    assert.deepEqual(l.peaks.map(y => y + l.y0), [50, 80, 115]);
    assert.ok(Math.abs(l.editing - 20) <= 1, `${JSON.stringify(b)}: ${l.editing}`);
    assert.ok(!l.flags.includes('band above the parent'), 'removed band is not flagged as a band above');
  }
});

test('a removed band where a product was expected is still left out', () => {
  const p = 0.4, fc = 1 - (1 - p) ** 2, B = [[40, 1 - fc], [90, fc * 2 / 3], [140, fc / 3]];
  const lanes = [60, 160, 260, 360, 460, 560].map(x => ({ x, bands: B }));
  const row = analyseWith(bandGel(lanes, { w: 650, h: 190 }), { x0: 0, x1: 650, y0: 5, y1: 185 }, i => (i === 3 ? { parent: null, products: [null, null], removed: [90] } : null));
  const l = row.lanes[3], ref = row.lanes[2];
  assert.ok(Math.abs(l.areas[2] - ref.areas[2]) < 0.05 * ref.areas[2], `product 2 area ${l.areas[2]} vs ${ref.areas[2]}`);
});

test('bands that run into each other are flagged when the result depends on the baseline', () => {
  const broad = [[40, 0.64, 6], [60, 0.24, 6], [80, 0.12, 6]];
  const lanes = [60, 160, 260, 360, 460, 560].map(x => ({ x, bands: broad }));
  const row = analyseBox(bandGel(lanes, { w: 650, h: 220 }), { x0: 0, x1: 650, y0: 5, y1: 210 });
  assert.ok(row.lanes[2].flags.includes('bands overlap: result depends on the baseline'), `flags [${row.lanes[2].flags.join('; ')}]`);
  // Separated bands are not flagged.
  const clean = analyseBox(bandGel(fourLanes(20), { w: 500 }), { x0: 0, x1: 500, y0: 5, y1: 135 });
  clean.lanes.forEach((l, i) => assert.ok(!l.flags.some(f => /overlap/.test(f)), 'clean lane ' + i));
});

test('an extra band is flagged only in the lanes that carry it', () => {
  const lanes = [60, 160, 260, 360, 460, 560, 660, 760].map((x, i) => ({ x, bands: t7Bands(20, i % 2 ? [] : [[130, 0.06]]) }));
  const row = analyseBox(bandGel(lanes, { w: 840 }), { x0: 0, x1: 840, y0: 5, y1: 160 });
  row.lanes.forEach((l, i) => {
    assert.ok(Math.abs(l.editing - 20) <= 2, `lane ${i}: ${l.editing}`);
    assert.equal(l.flags.includes('extra band not matching the cleavage products'), i % 2 === 0, `lane ${i}: [${l.flags.join('; ')}]`);
  });
});

test('a parent removed in one lane does not move the grouping of another', () => {
  const A = [[40, 0.64], [70, 0.24], [105, 0.12]], B = [[40, 0.3], [90, 1], [140, 0.03]], C = [[40, 0.36], [90, 0.64 * 2 / 3], [140, 0.64 / 3]];
  const lanes = [A, A, A, B, C, A].map((bands, i) => ({ x: 60 + 100 * i, bands }));
  const img = bandGel(lanes, { w: 650, h: 220 }), box = { x0: 0, x1: 650, y0: 5, y1: 210 };
  const auto = analyseWith(img, box, () => null), edited = analyseWith(img, box, i => (i === 3 ? { parent: null, products: [null, null], removed: [40] } : null));
  edited.lanes.forEach((l, i) => { if (i !== 3) assert.deepEqual([l.editing, l.peaks], [auto.lanes[i].editing, auto.lanes[i].peaks], 'lane ' + i); });
});

test('lane order does not change which lanes are ends of the row', () => {
  const ladder = [[20, 0.5], [45, 0.5], [70, 0.5], [95, 0.5], [120, 0.5]];
  const lanes = [{ x: 60, bands: ladder }].concat([160, 260, 360].map(x => ({ x, bands: t7Bands(20) })));
  const img = bandGel(lanes, { w: 450, h: 150 }), box = { x0: 0, x1: 450, y0: 5, y1: 140 };
  const run = xs => T.analyze(img, [Object.assign({}, box, { pitch: 100, lanes: xs.map(x => ({ x, role: null })) })], { polarity: 'dark' }).rows[0];
  const sorted = run([60, 160, 260, 360]), shuffled = run([160, 60, 260, 360]);
  const byX = r => Object.fromEntries(r.lanes.map(l => [l.x, l.role + ' ' + l.editing]));
  assert.deepEqual(byX(shuffled), byX(sorted));
  assert.equal(sorted.lanes[0].role, 'marker');
});

test('removing the real parent leaves a lane that says only one product is left', () => {
  // The vote still expects the second product where only flat background is left.
  const lanes = [70, 170, 270, 370, 470, 570].map(x => ({ x, bands: [[45, 0.36], [77, 0.64 * 2 / 3], [113, 0.64 / 3]] }));
  const img = bandGel(lanes, { w: 680, h: 180 }), box = { x0: 10, x1: 660, y0: 8, y1: 170 };
  const l = analyseWith(img, box, i => (i === 2 ? { parent: null, products: [null, null], removed: [45] } : null)).lanes[2];
  assert.ok(l.flags.some(f => WARNING.test(f)), `${l.editing.toFixed(1)}% [${l.flags.join('; ')}]`);
});

test('a product set by hand keeps its slot when the row has no product positions', () => {
  // One lane, products too faint for the vote: both are set by hand.
  const img = bandGel([{ x: 60, bands: [[30, 1], [60, 0.012], [95, 0.008]] }], { w: 140, h: 140, amp: 160 });
  const run = bands => T.analyze(img, [{ x0: 0, x1: 140, y0: 5, y1: 135, pitch: 100, lanes: [{ x: 60, role: null, bands }] }], { polarity: 'dark' }).rows[0].lanes[0];
  const two = run({ parent: null, products: [null, 90], removed: [] });
  assert.equal(two.areas[1], 0, 'product 1 is empty');
  assert.ok(two.areas[2] > 0, 'product 2 measured in its own column');
  const both = run({ parent: null, products: [55, 90], removed: [] });
  assert.ok(both.areas[1] > 0 && both.areas[2] > 0);
  assert.ok(!both.flags.includes('no cleavage products found'), `[${both.flags.join('; ')}]`);
});

function analyseLanes(img, box, laneOf) {
  const sig = T.signalImage(img, 'dark');
  const d = T.detectLanes(sig, img, box);
  return T.analyze(img, [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map((x, i) => Object.assign({ x, role: null, bands: null }, laneOf(i))) })], { polarity: 'dark' }).rows[0];
}

test('removing a band in one end lane does not turn the other end lane into a ladder', () => {
  const lanes = [60, 160, 260].map((x, i) => ({ x, bands: t7Bands(20, i === 1 ? [] : [[130, 0.3]]) }));
  const img = bandGel(lanes, { w: 320, h: 170 }), box = { x0: 0, x1: 320, y0: 5, y1: 160 };
  const auto = analyseLanes(img, box, () => ({}));
  const edited = analyseLanes(img, box, i => (i === 0 ? { bands: { parent: null, products: [null, null], removed: [130] } } : {}));
  [1, 2].forEach(i => assert.deepEqual([edited.lanes[i].role, edited.lanes[i].editing, edited.lanes[i].flags], [auto.lanes[i].role, auto.lanes[i].editing, auto.lanes[i].flags], 'lane ' + i));
});

test('an edit in one lane keeps the row warnings of the others, and a lane that looked like a ladder can re-fit', () => {
  const A = t7Bands(15).map(([y, m]) => [y + 10, m]);
  const fc = 1 - 0.6 ** 2, B = [[40, 1 - fc], [90, fc * 2 / 3], [140, fc / 3]];
  const lanes = ['A', 'A', 'A', 'B', 'B', 'B'].map((k, i) => ({ x: 60 + i * 100, bands: (k === 'A' ? A : B).concat(i === 1 ? [[14, 0.3]] : []) }));
  const img = bandGel(lanes, { w: 650, h: 175 }), box = { x0: 0, x1: 650, y0: 5, y1: 165 };
  const auto = analyseLanes(img, box, () => ({}));
  const edited = analyseLanes(img, box, i => (i === 1 ? { bands: { parent: null, products: [null, null], removed: [14] } } : {}));
  assert.ok(Math.abs(edited.lanes[1].editing - 15) <= 1, 'edited lane ' + edited.lanes[1].editing);
  [0, 2, 3, 4, 5].forEach(i => assert.deepEqual(edited.lanes[i].flags, auto.lanes[i].flags, 'lane ' + i));
});

test('a product position seen in only a few lanes makes those lanes warn', () => {
  const fc = 1 - 0.8 ** 2;
  const lanes = [...Array(8)].map((_, i) => ({ x: 60 + i * 100, bands: [[30, 1 - fc], [60, fc * 2 / 3]].concat(i === 2 || i === 5 ? [[110, 0.3]] : []) }));
  const row = analyseBox(bandGel(lanes, { w: 840 }), { x0: 0, x1: 840, y0: 5, y1: 160 });
  row.lanes.forEach((l, i) => assert.ok(l.flags.some(f => WARNING.test(f)), `lane ${i}: ${l.editing.toFixed(1)} [${l.flags.join('; ')}]`));
});

test('a band boundary dragged past a band is flagged', () => {
  const lanes = [60, 160, 260, 360].map(x => ({ x, bands: [[30, 0.64], [60, 0.24], [95, 0.12]] }));
  const img = bandGel(lanes, { w: 500 }), box = { x0: 0, x1: 500, y0: 5, y1: 135 };
  const l = analyseLanes(img, box, () => ({})).lanes[1], v = l.valleys.map(i => i + l.y0);
  v[1] = 70;   // past product 1 at 60
  const dragged = analyseLanes(img, box, i => (i === 1 ? { valleys: v } : {})).lanes[1];
  assert.ok(dragged.flags.includes('band boundary crosses a band'), `[${dragged.flags.join('; ')}]`);
});

test('a product on a broad smear is measured on its own base, not with the plateau under it', () => {
  // Four lanes at 30% editing; lane 2 also carries a wide smear of small fragments whose top lies just
  // below product 2, as on a real gel photo (reference gel IM003690). The box ends inside the smear.
  // Summed from boundary to boundary the plateau under product 2 would read as product, 10 points high.
  const lanes = [60, 160, 260, 360].map((x, i) => ({ x, bands: t7Bands(30, i === 1 ? [[112, 0.12, 22]] : []) }));
  const row = analyseBox(bandGel(lanes, { w: 500 }), { x0: 0, x1: 500, y0: 5, y1: 125 });
  const clean = row.lanes[0].editing, smeared = row.lanes[1].editing;
  assert.ok(Math.abs(smeared - clean) <= 1.5, `smeared lane ${smeared.toFixed(1)} vs clean ${clean.toFixed(1)} [${row.lanes[1].flags.join('; ')}]`);
});

// Safety checks that no other test would miss if they broke.
test('a band between the products in one lane is flagged as unassigned', () => {
  const lanes = fourLanes(20).map((l, i) => (i === 2 ? { x: l.x, bands: l.bands.concat([[78, 0.15]]) } : l));
  const row = analyseBox(bandGel(lanes, { w: 500 }), { x0: 0, x1: 500, y0: 5, y1: 135 });
  assert.ok(row.lanes[2].flags.includes('unassigned band inside the measured range'), `[${row.lanes[2].flags}]`);
  [0, 1, 3].forEach(i => assert.ok(!row.lanes[i].flags.includes('unassigned band inside the measured range'), 'lane ' + i));
});

test('a clipped product band is flagged', () => {
  const img = bandGel(fourLanes(70), { w: 500, amp: 400 });
  for (let i = 0; i < img.gray.length; i++) img.gray[i] = Math.max(0, img.gray[i]);
  const row = analyseBox(img, { x0: 0, x1: 500, y0: 5, y1: 135 });
  row.lanes.forEach((l, i) => assert.ok(l.flags.includes('product saturated'), `lane ${i}: [${l.flags}]`));
});

test('a lone faint bump in an uncut lane is not counted as a product', () => {
  const lanes = fourLanes([20, 20, 20, 0]).map((l, i) => (i === 3 ? { x: l.x, bands: [[30, 1], [60, 0.004]] } : l));
  const img = bandGel(lanes, { w: 500 });
  let seed = 11;
  for (let i = 0; i < img.gray.length; i++) { seed = (seed * 16807) % 2147483647; img.gray[i] += (seed / 2147483647 - 0.5) * 3; }
  const l = analyseBox(img, { x0: 0, x1: 500, y0: 5, y1: 135 }).lanes[3];
  assert.equal(l.editing, 0, `[${l.flags}]`);
  assert.ok(l.flags.includes('product 1 not detected'));
});

test('one-product mode on lanes with two products asks for two', () => {
  const img = bandGel(fourLanes(20), { w: 500 }), box = { x0: 0, x1: 500, y0: 5, y1: 135 };
  const d = T.detectLanes(T.signalImage(img, 'dark'), img, box);
  const row = T.analyze(img, [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null })) })], { polarity: 'dark', products: 1 }).rows[0];
  row.lanes.forEach((l, i) => assert.ok(l.flags.some(f => /second product visible/.test(f)), `lane ${i}: [${l.flags}]`));
});

test('one lane at high editing with its faint parent above warns instead of reading 0%', () => {
  const g = new Float32Array(120 * 110).fill(200);
  for (let x = 35; x <= 85; x++) for (let y = 0; y < 110; y++) g[y * 120 + x] = 200 - 100 * (0.0289 * Math.exp(-((y - 30) ** 2) / 32) + 0.9711 * Math.exp(-((y - 65) ** 2) / 32));
  for (const products of [1, 2]) {
    const l = T.analyze(T.makeImage(g, 120, 110), [{ x0: 10, x1: 110, y0: 0, y1: 110, pitch: 100, lanes: [{ x: 60, role: null }] }], { polarity: 'dark', products }).rows[0].lanes[0];
    assert.ok(Math.abs(l.editing - 83) <= 10 || l.flags.some(T.isWarning), `${products} products: ${l.editing}% [${l.flags}]`);
  }
});

test('a missing product stays missing and warned when the boundaries are set by hand', () => {
  const fc = 1 - 0.8 ** 2;
  const lanes = [60, 160, 260, 360, 460, 560].map((x, i) => ({ x, bands: [[30, 1 - fc], [60, fc * 2 / 3]].concat(i === 2 ? [] : [[95, fc / 3]]) }));
  const img = bandGel(lanes, { w: 650 }), box = { x0: 0, x1: 650, y0: 5, y1: 160 };
  const auto = analyseLanes(img, box, () => ({})).lanes[2], v = auto.valleys.map(y => y + auto.y0);
  v[1] += 1;
  const l = analyseLanes(img, box, i => (i === 2 ? { valleys: v } : {})).lanes[2];
  assert.equal(l.areas[2], 0);
  assert.ok(l.flags.includes('only one cleavage product found') && l.flags.includes('product 2 not detected'), `[${l.flags}]`);
});
