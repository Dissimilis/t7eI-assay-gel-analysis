/*
 * Synthetic T7E1 gel with known editing values.
 *
 * Two rows of a marker plus twelve lanes, dark bands on a light ground, 8-bit
 * values. Band mass follows the reannealing model, so the true % editing of
 * every lane is known. Used by the "Sample gel" button and by the tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.T7E1Sample = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 1400, H = 900, PITCH = 92, X0 = 110;
  const PARENT_BP = 600, CUT_BP = [400, 200];

  // Per lane: true % editing and relative DNA load. Lane 0 of each row is the ladder.
  const ROWS = [
    { well: 110, parent: 228, tilt: 0,  lanes: [[22, 1], [15, 1], [31, 1.1], [8, 0.9], [0, 1, 'nc'], [18, 1], [25, 1.2], [12, 0.8], [27, 1], [35, 7, 'saturated'], [5, 1], [19, 1]] },
    { well: 500, parent: 616, tilt: 16, lanes: [[14, 1], [20, 1.1], [0, 1, 'nc'], [28, 1], [9, 1], [23, 0.9], [16, 0.35, 'weak'], [30, 1.1], [11, 1], [26, 1], [24, 1.2], [17, 1]] }
  ];
  const OFFSETS = [31, 70];        // product migration below the parent (px)
  const LADDER = [[-24, 1.1], [17, 0.75], [52, 0.6], [88, 0.5]];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fraction of DNA in the cleavage products for a given % editing (diverse indels). */
  function fractionCleaved(editingPct) {
    const p = editingPct / 100;
    return 1 - (1 - p) * (1 - p);
  }

  function generate(seed) {
    const rnd = mulberry32(seed == null ? 7 : seed);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const dark = new Float32Array(W * H);
    const sigma = 4.2, unit = 760 / (sigma * Math.sqrt(2 * Math.PI));

    function band(xc, yc, mass, halfW) {
      const amp = unit * mass;
      const x0 = Math.max(0, Math.floor(xc - halfW - 8)), x1 = Math.min(W - 1, Math.ceil(xc + halfW + 8));
      const y0 = Math.max(0, Math.floor(yc - 6 * sigma)), y1 = Math.min(H - 1, Math.ceil(yc + 60));
      for (let x = x0; x <= x1; x++) {
        const gx = 0.5 * (Math.tanh((x - xc + halfW) / 2.5) - Math.tanh((x - xc - halfW) / 2.5));
        const u = (x - xc) / halfW, smile = 1.4 * u * u;
        for (let y = y0; y <= y1; y++) {
          const dy = y - (yc + smile);
          let v = Math.exp(-(dy * dy) / (2 * sigma * sigma));
          if (dy > 0) v += 0.035 * Math.exp(-dy / 14);           // trailing smear
          dark[y * W + x] += amp * gx * v;
        }
      }
    }

    function well(xc, yc) {
      for (let x = Math.round(xc - 20); x <= Math.round(xc + 20); x++) {
        for (let y = yc - 7; y <= yc + 7; y++) {
          const edge = x <= xc - 18 || x >= xc + 18 || y <= yc - 5 || y >= yc + 5;
          dark[y * W + x] += edge ? 55 : -14;
        }
      }
    }

    const truth = [];
    ROWS.forEach((row, ri) => {
      const lanes = [];
      const n = row.lanes.length + 1;
      for (let i = 0; i < n; i++) {
        const xc = X0 + i * PITCH + (rnd() - 0.5) * 2;
        const yc = row.parent + row.tilt * i / (n - 1);
        well(Math.round(xc), row.well);
        if (i === 0) {
          LADDER.forEach(([dy, m]) => band(xc, yc + dy, m, 17));
          lanes.push({ x: Math.round(xc), role: 'marker' });
          continue;
        }
        const [ed, load, tag] = row.lanes[i - 1];
        const fc = fractionCleaved(ed);
        band(xc, yc, load * (1 - fc), 17);
        CUT_BP.forEach((bp, k) => band(xc, yc + OFFSETS[k], load * fc * bp / PARENT_BP, 17));
        lanes.push({ x: Math.round(xc), editing: ed, role: tag === 'nc' ? 'nc' : 'sample', tag: tag || null });
      }
      truth.push({
        x0: X0 - PITCH / 2, x1: X0 + (n - 0.5) * PITCH,
        y0: row.parent - 34, y1: row.parent + row.tilt + OFFSETS[1] + 34,
        lanes
      });
    });

    const gray = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - W / 2) / W, dy = (y - H / 2) / H;
        const bg = 214 - 10 * x / W - 26 * (dx * dx + dy * dy);
        const v = bg - dark[y * W + x] + 2.2 * gauss();
        gray[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
    return { w: W, h: H, gray, rows: truth, name: 'sample-t7eI-gel.png' };
  }

  return { generate, fractionCleaved };
});
