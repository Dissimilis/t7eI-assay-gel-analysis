// Rules that must hold on every gel, checked on seeded random synthetic gels (tests/gels.js).
// A failure prints the seed: `t7Row(seed, opts)` rebuilds that gel.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/analysis.js');
const { rng, t7Row, analyseRow } = require('./gels.js');

const MODES = [];
for (const background of ['valley', 'blend', 'envelope']) for (const products of [2, 1]) MODES.push({ background, products });
const label = m => `${m.background}, ${m.products} product${m.products > 1 ? 's' : ''}`;

/** Sample lanes off by more than `tol` points without a warning flag. */
function silentErrors(seeds, opts, tol) {
  const out = [];
  let lanes = 0;
  for (const seed of seeds) {
    const g = t7Row(seed, opts), row = analyseRow(g.img, g.box, null, { background: opts.background, products: opts.products });
    assert.equal(row.lanes.length, g.truth.length, `seed ${seed}: lanes found`);
    row.lanes.forEach((l, i) => {
      lanes++;
      if (l.role !== 'sample') return;   // shown as a ladder, not as a number; "Measure this lane" overrides it
      if (Math.abs(l.editing - g.truth[i]) > tol && !l.flags.some(T.isWarning)) out.push(`seed ${seed} lane ${i}: ${l.editing.toFixed(1)}% vs ${g.truth[i].toFixed(1)}% [${l.flags.join('; ')}]`);
    });
  }
  return { out, lanes };
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

for (const m of MODES) {
  test(`gels in the normal range read within 2.5 points or warn (${label(m)})`, () => {
    const { out } = silentErrors(range(1, 120), m, 2.5);
    assert.deepEqual(out, []);
  });
}

for (const m of MODES) {
  test(`hard gels never read more than 10 points off without a warning (${label(m)})`, () => {
    // Close bands, noise, sloped background, dimers, wells and clipping.
    const opts = Object.assign({ hard: true }, m);
    assert.deepEqual(silentErrors(range(1, 150), opts, 10).out, []);
    // Smaller misses without a warning stay rare: mostly Valley where bands nearly touch.
    const small = silentErrors(range(1, 150), opts, 2.5);
    assert.ok(small.out.length <= 0.015 * small.lanes,`${small.out.length} of ${small.lanes} lanes off by more than 2.5 points without a warning`);
  });
}

test('a hand edit changes only its own lane', () => {
  const r = rng(99);
  for (let seed = 1; seed <= 80; seed++) {
    const g = t7Row(seed, { hard: seed % 2 === 0 }), auto = analyseRow(g.img, g.box);
    const k = r.int(0, auto.lanes.length - 1), l = auto.lanes[k], abs = y => y + l.y0;
    const cands = (l.candidates.length ? l.candidates : l.peaks).map(abs);
    const kind = r.pick(['remove', 'parent', 'product 1', 'product 2', 'valleys', 'measure']);
    const edit = kind === 'remove' ? { bands: { parent: null, products: [null, null], removed: [r.pick(cands)] } }
      : kind === 'parent' ? { bands: { parent: r.pick(cands), products: [null, null], removed: [] } }
        : kind === 'product 1' ? { bands: { parent: null, products: [r.pick(cands), null], removed: [] } }
          : kind === 'product 2' ? { bands: { parent: null, products: [null, r.pick(cands)], removed: [] } }
            : kind === 'valleys' ? { valleys: l.valleys.map((v, i) => abs(v) + (i === 1 ? 2 : 0)) }
              : { role: 'sample' };
    const edited = analyseRow(g.img, g.box, i => (i === k ? edit : {}));
    const same = (x, a, what) => assert.deepEqual([x.role, x.editing, x.peaks, x.areas, x.flags], [a.role, a.editing, a.peaks, a.areas, a.flags], what);
    edited.lanes.forEach((x, i) => { if (i !== k) same(x, auto.lanes[i], `seed ${seed}, ${kind} in lane ${k}, lane ${i}`); });
    // A second edit elsewhere leaves the first edited lane as it was.
    const k2 = (k + 1 + r.int(0, auto.lanes.length - 2)) % auto.lanes.length;
    if (k2 !== k) {
      const both = analyseRow(g.img, g.box, i => (i === k ? edit : i === k2 ? { role: 'sample' } : {}));
      same(both.lanes[k], edited.lanes[k], `seed ${seed}, ${kind} in lane ${k} then a second edit in lane ${k2}`);
    }
  }
});

test('confirming the band the app chose changes nothing', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const g = t7Row(seed, { hard: seed % 2 === 0 }), auto = analyseRow(g.img, g.box);
    auto.lanes.forEach((l, k) => {
      if (l.role !== 'sample') return;
      const abs = y => y + l.y0, edits = { parent: { bands: { parent: abs(l.peaks[0]), products: [null, null], removed: [] } }, measure: { role: 'sample' } };
      if (l.found[1]) edits['product 1'] = { bands: { parent: null, products: [abs(l.peaks[1]), null], removed: [] } };
      if (l.found[2]) edits['product 2'] = { bands: { parent: null, products: [null, abs(l.peaks[2])], removed: [] } };
      for (const [kind, edit] of Object.entries(edits)) {
        const e = analyseRow(g.img, g.box, i => (i === k ? edit : {})).lanes[k];
        assert.equal(e.editing, l.editing, `seed ${seed} lane ${k}: ${kind}`);
        assert.equal(e.flags.some(T.isWarning), l.flags.some(T.isWarning), `seed ${seed} lane ${k}: ${kind} changes the warning [${l.flags}] -> [${e.flags}]`);
      }
    });
  }
});

test('nudging a band boundary by one pixel keeps the lane warnings', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const g = t7Row(seed, { hard: true }), auto = analyseRow(g.img, g.box);
    auto.lanes.forEach((l, k) => {
      if (l.role !== 'sample' || !l.flags.some(T.isWarning)) return;
      const v = l.valleys.map(y => y + l.y0); v[0] += v[1] - v[0] > 2 ? 1 : 0;
      const e = analyseRow(g.img, g.box, i => (i === k ? { valleys: v } : {})).lanes[k];
      assert.ok(e.flags.some(T.isWarning), `seed ${seed} lane ${k}: [${l.flags}] -> [${e.flags}]`);
    });
  }
});

test('heavy smoothing rarely moves a value without a warning', () => {
  let lanes = 0, silent = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const g = t7Row(seed), row = analyseRow(g.img, g.box, null, { smoothing: 4 });
    row.lanes.forEach((l, i) => { if (l.role !== 'sample') return; lanes++; if (Math.abs(l.editing - g.truth[i]) > 2.5 && !l.flags.some(T.isWarning)) silent++; });
  }
  assert.ok(silent <= 0.01 * lanes, `${silent} of ${lanes} lanes`);
});

test('regressions found in review: these lanes are right or warned', () => {
  // Faint parents missed at high editing (the neighbours show them), and one-product rows that took
  // a primer dimer for the product.
  const cases = [[2789, 3, 2], [2726, 2, 2], [509, 2, 2], [617, 0, 1], [617, 1, 1], [617, 2, 1], [8, 0, 1], [449, 1, 1], [910, 2, 1],
    [205, 3, 1], [324, 0, 1], [324, 3, 1], [437, 1, 1], [620, 0, 1], [1204, 0, 1], [1115, 2, 1]];
  for (const [seed, lane, products] of cases) {
    const g = t7Row(seed, { hard: true, products }), l = analyseRow(g.img, g.box, null, { products }).lanes[lane];
    assert.ok(l.role !== 'sample' || Math.abs(l.editing - g.truth[lane]) <= 10 || l.flags.some(T.isWarning), `seed ${seed} lane ${lane}: ${l.editing.toFixed(1)} vs ${g.truth[lane].toFixed(1)} [${l.flags}]`);
  }
  // The true parent chosen by hand after the row learnt its product positions from misread lanes.
  const g = t7Row(79, { hard: true }), auto = analyseRow(g.img, g.box);
  const truthParent = g.lanes[2].bands[0][0];
  const l = analyseRow(g.img, g.box, i => (i === 2 ? { bands: { parent: truthParent, products: [null, null], removed: [] } } : {})).lanes[2];
  assert.ok(Math.abs(l.editing - g.truth[2]) <= 10 || l.flags.some(T.isWarning), `seed 79 lane 2 with the true parent: ${l.editing.toFixed(1)} vs ${g.truth[2].toFixed(1)} [${l.flags}]`);
  assert.ok(auto.lanes.length > 2);
});

test('lane order does not change any result', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const g = t7Row(seed, { hard: seed % 2 === 0 });
    const sig = T.signalImage(g.img, 'dark'), d = T.detectLanes(sig, g.img, g.box);
    const run = xs => T.analyze(g.img, [Object.assign({}, g.box, { pitch: d.pitch, lanes: xs.map(x => ({ x, role: null })) })], { polarity: 'dark' }).rows[0];
    const byX = row => Object.fromEntries(row.lanes.map(l => [l.x, [l.role, l.editing, l.flags]]));
    const shuffled = d.xs.slice().reverse();
    assert.deepEqual(byX(run(shuffled)), byX(run(d.xs)), 'seed ' + seed);
  }
});

test('random boxes and settings never crash, and finite images give finite results', () => {
  const r = rng(7);
  for (let i = 0; i < 400; i++) {
    const g = t7Row(r.int(1, 1e6), { hard: r() < 0.5, lanes: r.int(1, 8) });
    const w = g.img.w, h = g.img.h;
    const x0 = r.int(0, w - 2), y0 = r.int(0, h - 2);
    const box = { x0, y0, x1: Math.min(w, x0 + r.int(1, w)), y1: Math.min(h, y0 + r.int(1, h)) };
    const params = { polarity: r.pick(['dark', 'light']), products: r.pick([1, 2]), background: r.pick(['valley', 'blend', 'envelope']),
      laneWidth: r.range(0.1, 0.9), smoothing: r.range(0, 4) };
    const sig = T.signalImage(g.img, params.polarity), d = T.detectLanes(sig, g.img, box);
    const lanes = d.xs.map(x => ({ x, role: null, valleys: r() < 0.1 ? [box.y0 + 2, box.y1 - 2] : null }));
    const res = T.analyze(g.img, [Object.assign({}, box, { pitch: d.pitch, lanes })], params).rows[0];
    res.lanes.forEach(l => { if (l.role === 'sample') assert.ok(Number.isFinite(l.editing), `run ${i}: editing ${l.editing}`); });
  }
});

test('the same input gives the same result', () => {
  const g = t7Row(5, { hard: true });
  assert.deepEqual(JSON.stringify(analyseRow(g.img, g.box)), JSON.stringify(analyseRow(g.img, g.box)));
});
