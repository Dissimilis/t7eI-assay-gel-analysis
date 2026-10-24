// Release audit: one independent random row per seed, from a seed block reserved for audits and never
// used for tuning. Counts silent misses (more than 10 points off, no warning) among lanes the image
// can decide, the 95% upper bound on their rate, and coverage (the share of lanes given a value
// without a warning). Run: node tests/audit.js [rows] [first seed]. The README states the result.
'use strict';
const T = require('../js/analysis.js');
const { rng, t7Row } = require('./gels.js');

const ROWS = +(process.argv[2] || 30000), FIRST = +(process.argv[3] || 1000001);

/**
 * The image can decide a lane when its parent stands out of the noise (peak at least 2 grey levels and
 * 4 times the pixel noise), or when at least two lanes of the row keep 40% or more of their DNA uncut,
 * so the row shows where the parent runs.
 */
function decidable(g, lanes, i) {
  const fc = ed => 1 - (1 - ed / 100) ** 2;
  const parentPeak = g.features.amp * (1 - fc(g.truth[lanes[i]]));
  const anchors = lanes.filter(k => g.truth[k] < 60).length;
  return parentPeak >= Math.max(2, 4 * g.features.noise) || anchors >= 2;
}

/** 95% one-sided upper bound on a rate from k events in n trials (exact binomial, by bisection). */
function upper95(k, n) {
  if (!n) return 1;
  const cdf = p => { let s = 0, t = Math.pow(1 - p, n); for (let j = 0; j <= k; j++) { s += t; t *= (n - j) / (j + 1) * p / (1 - p); } return s; };
  let lo = 0, hi = 1;
  for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (cdf(mid) > 0.05) lo = mid; else hi = mid; }
  return hi;
}

const strata = {};
const add = (name, key) => { const s = strata[name] || (strata[name] = { results: 0, unflagged: 0, decidable: 0, miss: 0, undecidableMiss: 0, examples: [] }); return s; };
for (let seed = FIRST; seed < FIRST + ROWS; seed++) {
  const r = rng(seed * 2654435761 % 4294967296);
  const hard = r() < 0.5, products = r() < 0.5 ? 1 : 2, background = r.pick(['valley', 'blend', 'envelope']);
  const g = t7Row(seed, { hard, products });
  const sig = T.signalImage(g.img, 'dark');
  // Every other row is measured as drawn; the rest as a box of one to three of its lanes.
  const small = seed % 2 === 0;
  let lanes = g.truth.map((_, i) => i), box = g.box;
  if (small) {
    const k = Math.min(g.lanes.length, r.int(1, 3)), st = r.int(0, g.lanes.length - k), pitch = g.lanes[1].x - g.lanes[0].x;
    lanes = lanes.slice(st, st + k);
    box = { x0: Math.round(g.lanes[st].x - pitch / 2), x1: Math.round(g.lanes[st + k - 1].x + pitch / 2), y0: g.box.y0, y1: g.box.y1 };
  }
  const s = add(small ? 'boxes of 1-3 lanes' : 'full rows');
  const d = T.detectLanes(sig, g.img, box);
  s.results++;
  const i = r.int(0, lanes.length - 1);
  if (d.xs.length !== lanes.length) { s.miss++; s.decidable++; s.examples.push(`seed ${seed}: ${d.xs.length} lanes found of ${lanes.length}`); continue; }
  const l = T.analyze(g.img, [Object.assign({}, box, { pitch: d.pitch, lanes: d.xs.map(x => ({ x, role: null })) })], { polarity: 'dark', products, background }, sig).rows[0].lanes[i];
  const warned = l.role !== 'sample' || l.flags.some(T.isWarning);
  if (!warned) s.unflagged++;
  const off = !warned && Math.abs(l.editing - g.truth[lanes[i]]) > 10;
  if (decidable(g, lanes, i)) { s.decidable++; if (off) { s.miss++; s.examples.push(`seed ${seed} lane ${lanes[i]} (${hard ? 'hard' : 'normal'}, ${products} product${products > 1 ? 's' : ''}, ${background}): ${l.editing.toFixed(1)}% vs ${g.truth[lanes[i]].toFixed(1)}%`); } }
  else if (off) s.undecidableMiss++;
}
let fail = false;
for (const [name, s] of Object.entries(strata)) {
  const bound = upper95(s.miss, s.decidable);
  console.log(`${name}: ${s.results} independent results, ${s.decidable} decidable; silent misses ${s.miss} (95% upper bound 1 in ${Math.round(1 / bound).toLocaleString('en-US')}); ` +
    `unflagged ${(100 * s.unflagged / s.results).toFixed(1)}%; misses on undecidable lanes ${s.undecidableMiss}`);
  s.examples.forEach(x => console.log('  ' + x));
  if (s.miss) fail = true;
}
process.exitCode = fail ? 1 : 0;
