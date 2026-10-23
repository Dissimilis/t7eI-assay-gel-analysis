/*
 * T7E1 gel densitometry engine.
 *
 * Pure functions, no DOM. Loaded as a classic script in the browser (global
 * `T7E1`) and with require() in Node for the tests.
 *
 * Pipeline per row of lanes:
 *   signal image -> lane finding -> mean vertical profile per lane ->
 *   parent band + consensus cleavage-product offsets -> valleys ->
 *   baseline -> band areas -> fraction cleaved -> % editing.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.T7E1 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    polarity: 'dark',      // 'dark' = dark bands on a light background, 'light' = the opposite
    laneWidth: 0.5,        // measured strip width as a fraction of the lane pitch
    smoothing: 1.5,        // Gaussian sigma (px) applied to lane profiles
    background: 'valley',  // 'valley' | 'blend' | 'envelope'
    blendK: 0.15,          // valley-depth scale for the 'blend' baseline
    products: 2,           // number of cleavage products to quantify (1 or 2)
    formula: 'guschin',    // 'guschin' (diverse indels) | 'single' (one dominant allele)
    subtractNC: false,     // subtract the mean NC fraction cleaved before the formula
    faintSNR: 3,           // product peaks below this signal-to-noise are flagged faint
    satFraction: 0.02      // flag a parent band when more than this share of its core pixels is clipped
  });

  const ROLES = ['sample', 'nc', 'marker', 'excluded'];

  // ---------------------------------------------------------------- images

  /** RGBA bytes -> luminance (0-255 floats). */
  function rgbaToGray(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    }
    return g;
  }

  /**
   * Wrap grayscale data as an image. `clipLow`/`clipHigh` are the values at or
   * beyond which a pixel counts as clipped (8-bit JPEGs never reach exactly 0).
   */
  function makeImage(gray, w, h, opts) {
    const o = opts || {};
    return {
      w, h, gray,
      bits: o.bits || 8,
      clipLow: o.clipLow != null ? o.clipLow : 3,
      clipHigh: o.clipHigh != null ? o.clipHigh : 252
    };
  }

  /** Dark bands on a light ground when the median is above mid-grey. */
  function detectPolarity(img) {
    const step = Math.max(1, Math.floor(img.gray.length / 20000));
    const s = [];
    for (let i = 0; i < img.gray.length; i += step) s.push(img.gray[i]);
    return median(s) > 127 ? 'dark' : 'light';
  }

  /** Band signal: positive where DNA is. */
  function signalImage(img, polarity) {
    const out = new Float32Array(img.gray.length);
    if (polarity === 'light') out.set(img.gray);
    else for (let i = 0; i < out.length; i++) out[i] = 255 - img.gray[i];
    return out;
  }

  // ---------------------------------------------------------------- 1-D helpers

  function median(arr) {
    if (!arr.length) return 0;
    const a = Array.from(arr).sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function smooth(p, sigma) {
    if (!(sigma > 0)) return Float32Array.from(p);
    const r = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float32Array(2 * r + 1);
    let ks = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    const n = p.length, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += k[j + r] * p[Math.min(n - 1, Math.max(0, i + j))];
      out[i] = s;
    }
    return out;
  }

  /** Morphological opening (min then max filter): a 1-D rolling ball. */
  function opening(p, radius) {
    const n = p.length, mn = new Float32Array(n), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) if (p[j] < m) m = p[j];
      mn[i] = m;
    }
    for (let i = 0; i < n; i++) {
      let m = -Infinity;
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) if (mn[j] > m) m = mn[j];
      out[i] = m;
    }
    return out;
  }

  /** Noise sigma from first differences (robust to slow trends and peaks). */
  function noiseSigma(p) {
    const d = [];
    for (let i = 1; i < p.length; i++) d.push(Math.abs(p[i] - p[i - 1]));
    return (1.4826 * median(d)) / Math.SQRT2;
  }

  function argmax(p, a, b) {
    a = Math.max(0, a | 0); b = Math.min(p.length - 1, b | 0);
    let k = a;
    for (let i = a; i <= b; i++) if (p[i] > p[k]) k = i;
    return k;
  }

  function argmin(p, a, b) {
    a = Math.max(0, a | 0); b = Math.min(p.length - 1, b | 0);
    let k = a;
    for (let i = a; i <= b; i++) if (p[i] < p[k]) k = i;
    return k;
  }

  function isLocalMax(p, i) {
    return i > 0 && i < p.length - 1 && p[i] >= p[i - 1] && p[i] >= p[i + 1];
  }

  /**
   * Peak prominence: height above the higher of the two flanking minima within
   * `reach`. A side that runs into the end of the profile gives no base, so a
   * band cut by the region edge is measured from its other side.
   */
  function prominence(p, i, reach) {
    let l = p[i], r = p[i], lEdge = true, rEdge = true;
    for (let j = i - 1; j >= Math.max(0, i - reach); j--) { if (p[j] > p[i]) { lEdge = false; break; } l = Math.min(l, p[j]); if (j > 0 && j === i - reach) lEdge = false; }
    for (let j = i + 1; j <= Math.min(p.length - 1, i + reach); j++) { if (p[j] > p[i]) { rEdge = false; break; } r = Math.min(r, p[j]); if (j < p.length - 1 && j === i + reach) rEdge = false; }
    if (i === 0) lEdge = true;
    if (i === p.length - 1) rEdge = true;
    if (lEdge && !rEdge) return p[i] - r;
    if (rEdge && !lEdge) return p[i] - l;
    if (lEdge && rEdge) return p[i] - Math.min(l, r);
    return p[i] - Math.max(l, r);
  }

  // ---------------------------------------------------------------- regions and lanes

  function normRegion(r, img) {
    const x0 = Math.max(0, Math.round(Math.min(r.x0, r.x1)));
    const x1 = Math.min(img.w, Math.round(Math.max(r.x0, r.x1)));
    const y0 = Math.max(0, Math.round(Math.min(r.y0, r.y1)));
    const y1 = Math.min(img.h, Math.round(Math.max(r.y0, r.y1)));
    return { x0, x1, y0, y1 };
  }

  function columnProfile(sig, w, r) {
    const n = r.x1 - r.x0, p = new Float32Array(n), rows = Math.max(1, r.y1 - r.y0);
    for (let y = r.y0; y < r.y1; y++) {
      const off = y * w;
      for (let i = 0; i < n; i++) p[i] += sig[off + r.x0 + i];
    }
    for (let i = 0; i < n; i++) p[i] /= rows;
    return p;
  }

  /** Lane pitch from the autocorrelation of the detrended column profile. */
  function estimatePitch(p) {
    const n = p.length;
    if (n < 24) return 0;
    const trend = smooth(p, Math.max(6, n / 12));
    const q = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) { q[i] = p[i] - trend[i]; mean += q[i]; }
    mean /= n;
    for (let i = 0; i < n; i++) q[i] -= mean;
    const maxLag = Math.floor(n / 2), ac = new Float32Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += q[i] * q[i + lag];
      ac[lag] = s / (n - lag);
    }
    const peaks = [];
    for (let lag = 6; lag < maxLag; lag++) {
      if (ac[lag] > 0 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) peaks.push(lag);
    }
    if (!peaks.length) return 0;
    const best = Math.max(...peaks.map(l => ac[l]));
    const first = peaks.find(l => ac[l] >= 0.5 * best);
    return first || 0;
  }

  /**
   * Find loaded lanes inside a region. Returns the lane pitch and lane centres
   * (absolute x). Empty lanes produce no peak and are skipped.
   */
  function detectLanes(sig, img, region) {
    const r = normRegion(region, img);
    const raw = columnProfile(sig, img.w, r);
    const p = smooth(raw, 2);
    let pitch = estimatePitch(p);
    const rad = Math.max(4, Math.round((pitch || p.length / 6) * 0.6));
    const base = opening(p, rad);
    const d = new Float32Array(p.length);
    let dmax = 0;
    for (let i = 0; i < p.length; i++) { d[i] = p[i] - base[i]; if (d[i] > dmax) dmax = d[i]; }
    const thr = Math.max(0.05 * dmax, 5 * noiseSigma(raw), 0.5);
    const cand = [];
    for (let i = 1; i < d.length - 1; i++) if (d[i] > thr && isLocalMax(d, i)) cand.push(i);
    const minSep = pitch ? 0.6 * pitch : 8;
    cand.sort((a, b) => d[b] - d[a]);
    let kept = [];
    for (const c of cand) if (kept.every(k => Math.abs(k - c) >= minSep)) kept.push(c);
    // Centre each lane on the midpoint of its half-maximum width (bands are flat-topped).
    kept = kept.map(c => {
      const half = d[c] / 2;
      let l = c, rr = c;
      while (l > 0 && d[l - 1] > half) l--;
      while (rr < d.length - 1 && d[rr + 1] > half) rr++;
      return Math.round((l + rr) / 2);
    });
    kept.sort((a, b) => a - b);
    if (!pitch) pitch = kept.length > 1 ? median(kept.slice(1).map((x, i) => x - kept[i])) : Math.max(8, p.length);
    return { pitch, xs: kept.map(i => i + r.x0) };
  }

  /** Mean signal of a vertical strip centred on x. */
  function laneProfile(sig, img, x, half, y0, y1) {
    const a = Math.max(0, Math.round(x - half)), b = Math.min(img.w - 1, Math.round(x + half));
    const n = y1 - y0, p = new Float32Array(n), cols = b - a + 1;
    for (let y = 0; y < n; y++) {
      let s = 0;
      const off = (y0 + y) * img.w;
      for (let xx = a; xx <= b; xx++) s += sig[off + xx];
      p[y] = s / cols;
    }
    return { p, a, b };
  }

  /** Share of clipped pixels in the band core around profile index `yi`. */
  function clippedShare(img, polarity, a, b, yAbs) {
    let n = 0, c = 0;
    for (let y = Math.max(0, yAbs - 2); y <= Math.min(img.h - 1, yAbs + 2); y++) {
      for (let x = a; x <= b; x++) {
        const v = img.gray[y * img.w + x];
        n++;
        if (polarity === 'light' ? v >= img.clipHigh : v <= img.clipLow) c++;
      }
    }
    return n ? c / n : 0;
  }

  // ---------------------------------------------------------------- bands

  /** Candidate product offsets (px below the parent) in one smoothed profile. */
  function productCandidates(ps, P, noise) {
    const height = ps[P] - Math.min(...ps);
    const minProm = Math.max(3 * noise, 0.04 * height);
    const out = [];
    for (let j = P + 4; j < ps.length - 1; j++) {
      if (!isLocalMax(ps, j)) continue;
      const prom = prominence(ps, j, Math.max(8, j - P));
      if (prom >= minProm) out.push({ off: j - P, prom });
    }
    return out;
  }

  /** Cluster offsets from all lanes of a row; keep the `k` most frequent. */
  function consensusOffsets(lists, k) {
    const all = [];
    lists.forEach(l => l.forEach(c => all.push(c.off)));
    all.sort((a, b) => a - b);
    const clusters = [];
    for (const off of all) {
      const c = clusters[clusters.length - 1];
      if (c && off - c.items[c.items.length - 1] <= 3 + 0.1 * off) c.items.push(off);
      else clusters.push({ items: [off] });
    }
    const lanes = lists.length;
    const minCount = lanes >= 3 ? Math.max(2, Math.ceil(0.25 * lanes)) : 1;
    return clusters
      .filter(c => c.items.length >= minCount)
      .sort((a, b) => b.items.length - a.items.length)
      .slice(0, k)
      .map(c => median(c.items))
      .sort((a, b) => a - b);
  }

  /** Piecewise-linear baseline through nodes at the valley indices. */
  function baselineNodes(ps, valleys, method, k) {
    const first = valleys[0], last = valleys[valleys.length - 1];
    const env = i => last === first ? ps[first] : ps[first] + (ps[last] - ps[first]) * (i - first) / (last - first);
    if (method === 'envelope') return valleys.map(env);
    if (method === 'blend') {
      const P = argmax(ps, first, last), pm = Math.max(1e-6, ps[P] - env(P));
      return valleys.map(i => {
        const depth = Math.max(0, ps[i] - env(i));
        const w = Math.exp(-depth / (k * pm));
        return w * ps[i] + (1 - w) * env(i);
      });
    }
    return valleys.map(i => ps[i]);
  }

  function interpBaseline(n, valleys, nodes) {
    const b = new Float32Array(n).fill(NaN);
    for (let s = 0; s < valleys.length - 1; s++) {
      const a = valleys[s], c = valleys[s + 1];
      for (let i = a; i <= c; i++) b[i] = c === a ? nodes[s] : nodes[s] + (nodes[s + 1] - nodes[s]) * (i - a) / (c - a);
    }
    return b;
  }

  // ---------------------------------------------------------------- formulas

  /** Guschin et al. 2010 / NEB: diverse indels, random reannealing. */
  function editingGuschin(fc) { return 100 * (1 - Math.sqrt(Math.max(0, 1 - fc))); }

  /** One dominant mutant allele: fc = 2p(1-p), valid for fc <= 0.5. */
  function editingSingle(fc) { return fc > 0.5 ? NaN : 100 * (1 - Math.sqrt(1 - 2 * fc)) / 2; }

  function editing(fc, formula) { return formula === 'single' ? editingSingle(fc) : editingGuschin(fc); }

  // ---------------------------------------------------------------- analysis

  /**
   * Analyse one row. `row` = { x0, y0, x1, y1, lanes: [{ x, role, valleys }] }
   * where `role` null means automatic and `valleys` (absolute y) is an optional
   * manual override.
   */
  function analyzeRow(sig, img, row, params) {
    const prm = Object.assign({}, DEFAULTS, params);
    const r = normRegion(row, img);
    const n = r.y1 - r.y0;
    const xs = row.lanes.map(l => l.x).sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    const pitch = row.pitch || (gaps.length ? median(gaps) : (r.x1 - r.x0) / 2);
    const half = Math.max(1, prm.laneWidth * pitch / 2);

    // First pass: profiles, parents and candidate product offsets.
    const pre = row.lanes.map(lane => {
      const { p, a, b } = laneProfile(sig, img, lane.x, half, r.y0, r.y1);
      const ps = smooth(p, prm.smoothing);
      const P = argmax(ps, 0, n - 1);
      const noise = Math.max(0.05, noiseSigma(p));
      return { lane, p, ps, a, b, P, noise, cands: productCandidates(ps, P, noise) };
    });
    const usable = pre.filter(q => q.lane.role !== 'marker' && q.lane.role !== 'excluded');
    let offsets = consensusOffsets(usable.map(q => q.cands), prm.products);
    if (offsets.length < prm.products && usable.length) {
      // Fall back to the strongest candidates of the most cleaved-looking lane.
      const best = usable.slice().sort((a, b) => sumProm(b.cands) - sumProm(a.cands))[0];
      offsets = best.cands.slice().sort((a, b) => b.prom - a.prom).slice(0, prm.products).map(c => c.off).sort((a, b) => a - b);
    }

    const lanes = pre.map(q => analyzeLane(q, offsets, n, r, img, prm));
    return { region: r, pitch, half, offsets, lanes };
  }

  function sumProm(c) { return c.reduce((s, x) => s + x.prom, 0); }

  function analyzeLane(q, offsets, n, r, img, prm) {
    const { ps, P, noise } = q;
    const flags = [];
    const parentProm = ps[P] - Math.min(...ps);

    // Products at the consensus offsets relative to this lane's own parent (handles tilt and smile).
    const prods = offsets.map((off, k) => {
      const lo = k === 0 ? Math.max(P + 3, P + off - (3 + 0.15 * off)) : P + (offsets[k - 1] + off) / 2;
      const hi = k === offsets.length - 1 ? P + off + 3 + 0.15 * off : P + (off + offsets[k + 1]) / 2;
      const c = argmax(ps, Math.round(lo), Math.round(hi));
      const found = c > P && c < n - 1 && isLocalMax(ps, c) && c > Math.round(lo) && c < Math.round(hi);
      return { y: found ? c : Math.min(n - 1, Math.round(P + off)), found };
    });

    // Valleys bracketing each band.
    const peaks = [P].concat(prods.map(x => x.y));
    let valleys;
    if (q.lane.valleys && q.lane.valleys.length === peaks.length + 1) {
      valleys = q.lane.valleys.map(v => Math.min(n - 1, Math.max(0, Math.round(v - r.y0)))).sort((a, b) => a - b);
      flags.push('manual band boundaries');
    } else {
      const firstGap = peaks.length > 1 ? peaks[1] - peaks[0] : Math.max(6, Math.round(n * 0.15));
      valleys = [argmin(ps, P - firstGap, P)];
      for (let i = 0; i < peaks.length - 1; i++) valleys.push(argmin(ps, peaks[i], peaks[i + 1]));
      const lastGap = peaks.length > 1 ? peaks[peaks.length - 1] - peaks[peaks.length - 2] : firstGap;
      valleys.push(argmin(ps, peaks[peaks.length - 1], peaks[peaks.length - 1] + lastGap));
      for (let i = 1; i < valleys.length; i++) if (valleys[i] < valleys[i - 1]) valleys[i] = valleys[i - 1];
    }

    const nodes = baselineNodes(ps, valleys, prm.background, prm.blendK);
    const baseline = interpBaseline(n, valleys, nodes);
    const areas = [];
    for (let s = 0; s < valleys.length - 1; s++) {
      let sum = 0;
      const end = s === valleys.length - 2 ? valleys[s + 1] : valleys[s + 1] - 1;
      for (let i = valleys[s]; i <= end; i++) sum += Math.max(0, ps[i] - baseline[i]);
      areas.push(sum);
    }
    prods.forEach((x, k) => {
      if (!x.found && !q.lane.valleys) { areas[k + 1] = 0; flags.push('product ' + (k + 1) + ' not detected'); }
    });

    const heights = peaks.map((y, i) => ps[y] - (isNaN(baseline[y]) ? nodes[Math.min(i, nodes.length - 1)] : baseline[y]));
    prods.forEach((x, k) => { if (x.found && heights[k + 1] < prm.faintSNR * noise) flags.push('product ' + (k + 1) + ' faint'); });
    if (!offsets.length) flags.push('no cleavage products found in row');

    const sat = clippedShare(img, prm.polarity, q.a, q.b, r.y0 + P);
    if (sat > prm.satFraction) flags.push('parent saturated');
    if (parentProm < Math.max(8 * noise, 10)) flags.push('weak lane');

    // Automatic role: a ladder has strong bands that match neither the parent nor the products.
    if (P <= 1 || P >= n - 2) flags.push('band touches region edge');
    let role = q.lane.role;
    if (!role) {
      role = 'sample';
      const matches = j => Math.abs(j - P) <= 4 || offsets.some(off => Math.abs(j - P - off) <= 3 + 0.15 * off);
      for (let j = 1; j < n - 1; j++) {
        if (!isLocalMax(ps, j) || matches(j)) continue;
        if (prominence(ps, j, Math.max(10, Math.round(n / 4))) >= 0.25 * parentProm) { role = 'marker'; break; }
      }
    }

    const total = areas.reduce((s, v) => s + v, 0);
    const fc = total > 0 ? (total - areas[0]) / total : 0;
    if (fc === 0 && offsets.length && role === 'sample') flags.push('no cleavage');

    return {
      x: q.lane.x, a: q.a, b: q.b, y0: r.y0,
      profile: ps, baseline, valleys, peaks, found: [true].concat(prods.map(x => x.found)),
      areas, heights, fc, role, flags, noise, saturated: sat, parentProm,
      editing: NaN, fcCorrected: fc
    };
  }

  /**
   * Analyse all rows, then apply NC correction and the editing formula.
   * `signal` is an optional precomputed signalImage() for the same polarity.
   * Returns { rows: [...], ncFc, ncCount }.
   */
  function analyze(img, rows, params, signal) {
    const prm = Object.assign({}, DEFAULTS, params);
    const sig = signal || signalImage(img, prm.polarity);
    const out = rows.map(row => analyzeRow(sig, img, row, prm));
    const nc = [];
    out.forEach(r => r.lanes.forEach(l => { if (l.role === 'nc') nc.push(l.fc); }));
    const ncFc = nc.length ? nc.reduce((s, v) => s + v, 0) / nc.length : 0;
    out.forEach(r => r.lanes.forEach(l => {
      if (l.role === 'marker' || l.role === 'excluded') { l.editing = NaN; l.flags = []; return; }
      l.fcCorrected = prm.subtractNC && l.role === 'sample' ? Math.max(0, l.fc - ncFc) : l.fc;
      l.editing = editing(l.fcCorrected, prm.formula);
      if (prm.formula === 'single' && l.fcCorrected > 0.5) l.flags.push('fraction cleaved > 0.5: single-allele model invalid');
    }));
    return { rows: out, ncFc, ncCount: nc.length };
  }

  return {
    DEFAULTS, ROLES,
    rgbaToGray, makeImage, detectPolarity, signalImage,
    smooth, opening, noiseSigma, median, estimatePitch,
    detectLanes, laneProfile, analyzeRow, analyze,
    editingGuschin, editingSingle, editing
  };
});
