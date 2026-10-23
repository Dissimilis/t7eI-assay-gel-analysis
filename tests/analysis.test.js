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
