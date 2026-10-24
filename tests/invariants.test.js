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
    // Close bands, noise, sloped background, dimers, wells and clipping. Two products give the
    // row enough to cross-check; with one product a few lanes above 75% editing slip through.
    const { out, lanes } = silentErrors(range(1, 150), Object.assign({ hard: true }, m), 10);
    if (m.products === 2) assert.deepEqual(out, []);
    else assert.ok(out.length <= 0.005 * lanes, `${out.length} of ${lanes} lanes:\n` + out.join('\n'));
  });
}

test('a hand edit changes only its own lane', () => {
  const r = rng(99);
  for (let seed = 1; seed <= 80; seed++) {
    const g = t7Row(seed, { hard: seed % 2 === 0 }), auto = analyseRow(g.img, g.box);
    const k = r.int(0, auto.lanes.length - 1), l = auto.lanes[k], abs = y => y + l.y0;
    const cands = (l.candidates.length ? l.candidates : l.peaks).map(abs);
    const kind = r.pick(['remove', 'parent', 'product', 'valleys', 'measure']);
    const edit = kind === 'remove' ? { bands: { parent: null, products: [null, null], removed: [r.pick(cands)] } }
      : kind === 'parent' ? { bands: { parent: r.pick(cands), products: [null, null], removed: [] } }
        : kind === 'product' ? { bands: { parent: null, products: [null, r.pick(cands)], removed: [] } }
          : kind === 'valleys' ? { valleys: l.valleys.map((v, i) => abs(v) + (i === 1 ? 2 : 0)) }
            : { role: 'sample' };
    const edited = analyseRow(g.img, g.box, i => (i === k ? edit : {}));
    edited.lanes.forEach((x, i) => {
      if (i === k) return;
      const a = auto.lanes[i];
      assert.deepEqual([x.role, x.editing, x.peaks, x.areas, x.flags], [a.role, a.editing, a.peaks, a.areas, a.flags], `seed ${seed}, ${kind} in lane ${k}, lane ${i}`);
    });
  }
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
