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
  v[1] -= 3;
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
      bands.forEach(([yc, m]) => { v += o.amp * m * Math.exp(-((y - yc) ** 2) / 32); });
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
const WARNING = /saturated|cut by|top of the box|unassigned|above the parent|extra band|check band|only one|second product/;

function bandGel(lanes, opts) {
  const o = Object.assign({ w: 900, h: 170, amp: 80 }, opts);
  const g = new Float32Array(o.w * o.h).fill(200);
  lanes.forEach(({ x, bands }) => {
    for (let xx = x - 17; xx <= x + 17; xx++) for (let y = 0; y < o.h; y++) {
      let v = 0;
      bands.forEach(([yc, m]) => { v += o.amp * m * Math.exp(-((y - yc) ** 2) / 32); });
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
  assertNotSilent(analyseBox(img, { x0: 0, x1: 500, y0: 5, y1: 100 }), [25, 25, 25, 25], 'bottom cut');
});

test('very high editing (70-80%) is not reported as about 18% without a warning', () => {
  const row = analyseBox(bandGel(fourLanes([70, 75, 80, 70]), { w: 500 }), { x0: 0, x1: 500, y0: 5, y1: 135 });
  assertNotSilent(row, [70, 75, 80, 70], 'high editing');
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
