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

  // Band matching, in profile pixels.
  const SAME_BAND = 3;                                    // two positions this close are one band
  const NEAR_BAND = 4;                                    // "next to" a band: no separate band fits here
  const offTol = off => 3 + 0.15 * off;                   // a band matches a product offset within this
  const reachOf = n => Math.max(10, Math.round(n / 4));   // how far prominence looks for the surrounding floor
  // Grouping lanes' offsets chains from one to the next, so each step is held tighter than offTol:
  // with offTol the clusters of neighbouring products merge (tested on random and real gels).
  const chainTol = off => 3 + 0.1 * off;

  // Overlapping bands: flagged when % editing on the lane's baseline and on a straight baseline
  // differ by at least `points` and by a factor of `ratio`, or by `large` points in any case, or when
  // a band fit differs from the lane's value by `fit` points.
  const OVERLAP = Object.freeze({ points: 4, ratio: 1.75, large: 8, fit: 3 });

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

  // Flags that say the lane's value should not be trusted as it stands; the rest are information.
  const WARNINGS = Object.freeze(['parent saturated', 'product saturated', 'weak lane', 'band cut by the box edge',
    'band at the top of the box: a well?', 'unassigned band inside the measured range', 'band above the parent',
    'extra band not matching the cleavage products', 'check band assignment', 'only one cleavage product found',
    'removed band overlaps a measured band', 'bands overlap: result depends on the baseline', 'band boundary crosses a band',
    'parent at a product position of the row', 'product positions differ from the row', 'result depends on the smoothing',
    'one product and few lanes: bands not cross-checked', 'parent lower than in nearby lanes']);
  function isWarning(flag) { return WARNINGS.includes(flag) || /invalid|second product visible/.test(flag); }

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
    // Sample the central 60% so a black or white surround around the gel does not decide it.
    const x0 = Math.floor(img.w * 0.2), x1 = Math.ceil(img.w * 0.8), y0 = Math.floor(img.h * 0.2), y1 = Math.ceil(img.h * 0.8);
    const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 20000)));
    const s = [];
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) s.push(img.gray[y * img.w + x]);
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

  function minOf(p) {
    let m = Infinity;
    for (let i = 0; i < p.length; i++) if (p[i] < m) m = p[i];
    return m;
  }

  /** Noise sigma from second differences: smooth band flanks do not inflate it. */
  function curvatureNoise(p) {
    const d = [];
    for (let i = 1; i < p.length - 1; i++) d.push(Math.abs(p[i + 1] - 2 * p[i] + p[i - 1]));
    return (1.4826 * median(d)) / Math.sqrt(6);
  }

  /** Nearest local maximum within `reach` of index i (the index itself when there is none). */
  function snapPeak(p, i, reach) {
    i = Math.min(p.length - 2, Math.max(1, Math.round(i)));
    let best = -1;
    for (let j = Math.max(1, i - reach); j <= Math.min(p.length - 2, i + reach); j++) {
      if (isLocalMax(p, j) && (best < 0 || Math.abs(j - i) < Math.abs(best - i) || (Math.abs(j - i) === Math.abs(best - i) && p[j] > p[best]))) best = j;
    }
    return best < 0 ? i : best;
  }

  /** Manual band choices of a lane (absolute image y) as profile indices: { parent, products: [i|null], removed: [i] }. */
  function laneOverrides(lane, ps, y0) {
    const b = lane.bands || {}, n = ps.length;
    const idx = y => (y == null || !isFinite(y) ? null : snapPeak(ps, y - y0, 3));
    const inside = i => i != null && i > 0 && i < n - 1;
    const parent = idx(b.parent), products = (b.products || []).map(idx);
    return {
      parent: inside(parent) ? parent : null,
      products: products.map(i => (inside(i) ? i : null)),
      removed: (b.removed || []).map(idx).filter(inside),
      any: b.parent != null || (b.products || []).some(v => v != null) || (b.removed || []).length > 0
    };
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
    const noise = noiseSigma(raw), mn = Math.min(...p), range = Math.max(...p) - mn;
    if (dmax < 5 * noise || dmax < 0.3 * range) {
      // The opening radius was too small to remove a band that fills most of the box, or lanes with
      // flat tops wider than it (a spacing misread from one or two lanes): only ripples were left.
      dmax = 0;
      for (let i = 0; i < p.length; i++) { d[i] = p[i] - mn; if (d[i] > dmax) dmax = d[i]; }
    }
    const thr = Math.max(0.05 * dmax, 5 * noise);
    const cand = [];
    for (let i = 1; i < d.length - 1; i++) if (d[i] > thr && isLocalMax(d, i)) cand.push(i);
    cand.sort((a, b) => d[b] - d[a]);
    const pick = minSep => {
      const out = [];
      for (const c of cand) {
        // A flat-topped band can have several maxima; keep one per half-maximum interval.
        if (out.some(k => (c >= k.l && c <= k.r) || Math.abs(k.c - c) < minSep)) continue;
        const half = d[c] / 2;
        let l = c, rr = c;
        while (l > 0 && d[l - 1] > half) l--;
        while (rr < d.length - 1 && d[rr + 1] > half) rr++;
        // A weaker maximum whose half-height span takes in a stronger lane is that lane's shoulder.
        if (out.some(k => k.c >= l && k.c <= rr)) continue;
        out.push({ c: Math.round((l + rr) / 2), l, r: rr });
      }
      return out;
    };
    const centres = ls => ls.map(k => k.c).sort((a, b) => a - b).filter((x, i, a) => i === 0 || x - a[i - 1] >= 4);
    let lanes = pick(pitch ? 0.6 * pitch : 8), xs = centres(lanes);
    if (pitch && xs.length >= 2) {
      // Every other lane dim: the autocorrelation peaks at twice the spacing, and its separation hides
      // all the dim lanes. Lanes picked at half that spacing, evenly about half the pitch apart, win.
      const half = pick(0.3 * pitch), hx = centres(half);
      const hg = hx.slice(1).map((x, i) => x - hx[i]);
      if (hx.length >= 2 * xs.length - 1 && hg.every(g => g > 0.35 * pitch && g < 0.65 * pitch)) { lanes = half; xs = hx; pitch = median(hg); }
    }
    // The autocorrelation needs several lanes; check it against the spacing of neighbouring lanes.
    if (xs.length >= 2) {
      const gaps = xs.slice(1).map((x, i) => x - xs[i]);
      const gmin = Math.min(...gaps);
      const adjacent = median(gaps.filter(g => g <= 1.3 * gmin));
      if (pitch && pitch > 1.25 * adjacent) {
        // Lanes alternating bright and dim make the autocorrelation pick twice the spacing, and the
        // separation it sets hides the dim lanes: pick again with the spacing of neighbouring lanes.
        lanes = pick(0.6 * adjacent); xs = centres(lanes);
      }
      if (!pitch || pitch < 0.8 * adjacent || pitch > 1.25 * adjacent) pitch = adjacent;
    } else if (xs.length === 1) {
      const width = lanes[0].r - lanes[0].l + 1;
      if (!pitch || pitch < 1.2 * width) pitch = width / 0.6;
    } else if (!pitch) {
      pitch = Math.max(8, p.length);
    }
    return { pitch, xs: xs.map(i => i + r.x0) };
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
    const height = ps[P] - minOf(ps);
    // Faint products next to a strong parent are typical of low editing: the noise floor matters most.
    const minProm = Math.max(3 * noise, 0.015 * height);
    const out = [];
    for (let j = P + NEAR_BAND; j < ps.length - 1; j++) {
      if (!isLocalMax(ps, j)) continue;
      const prom = prominence(ps, j, Math.max(8, j - P));
      if (prom >= minProm) out.push({ off: j - P, prom });
    }
    return out;
  }

  /** Cluster offsets from all lanes of a row; keep the `k` most frequent. */
  function consensusOffsets(lists, k, minLanes) {
    const all = [];
    lists.forEach((l, lane) => l.forEach(c => all.push({ off: c.off, prom: c.prom, lane })));
    all.sort((a, b) => a.off - b.off);
    const clusters = [];
    for (const it of all) {
      const c = clusters[clusters.length - 1];
      if (c && it.off - c.items[c.items.length - 1] <= chainTol(it.off)) { c.items.push(it.off); c.lanes.add(it.lane); c.prom += it.prom; }
      else clusters.push({ items: [it.off], lanes: new Set([it.lane]), prom: it.prom });
    }
    const lanes = lists.length;
    const minCount = minLanes != null ? minLanes : lanes >= 3 ? Math.max(2, Math.ceil(0.25 * lanes)) : 1;
    return clusters
      .filter(c => c.lanes.size >= minCount)
      .sort((a, b) => b.lanes.size - a.lanes.size || b.prom - a.prom)
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

  /** A lane the user changed by hand: band choices, boundaries, or "measure this lane". */
  function isEdited(lane) {
    const b = lane.bands;
    return lane.role === 'sample' || !!(lane.valleys && lane.valleys.length) ||
      !!(b && (b.parent != null || (b.products || []).some(v => v != null) || (b.removed || []).length));
  }

  /**
   * Analyse one row. `row` = { x0, y0, x1, y1, lanes: [{ x, role, valleys, bands }] }
   * where `role` null means automatic and `valleys` / `bands` (absolute y) are manual overrides.
   * A hand edit changes only its own lane: the row's shared decisions and every untouched lane
   * come from the same row with all edits taken out.
   */
  function analyzeRow(sig, img, row, params) {
    const edited = row.lanes.map(isEdited);
    if (!edited.some(Boolean)) return measureRow(sig, img, row, params);
    const plain = lane => ({ x: lane.x, role: lane.role === 'sample' ? null : lane.role, label: lane.label });
    const auto = measureRow(sig, img, Object.assign({}, row, { lanes: row.lanes.map(plain) }), params);
    const res = measureRow(sig, img, row, params, auto.context);
    res.lanes = res.lanes.map((l, i) => (edited[i] ? l : auto.lanes[i]));
    res.offsets = auto.offsets; res.shared = auto.shared;
    return res;
  }

  /** `ctx`: the row-level decisions of the same row without edits, reused when measuring edited lanes. */
  function measureRow(sig, img, row, params, ctx) {
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
      const noise = Math.max(1e-3, noiseSigma(p));
      const ov = laneOverrides(lane, ps, r.y0);
      const near = i => ov.removed.some(j => Math.abs(j - i) <= SAME_BAND);
      // Neither a removed band (for example a heteroduplex taken as parent) nor a band chosen by hand as a
      // product can be the automatic parent; the flank of a removed band is not a peak either.
      const notParent = i => near(i) || ov.products.some(j => j != null && Math.abs(j - i) <= SAME_BAND);
      let top = -1;
      for (let i = 1; i < n - 1; i++) if (!notParent(i) && isLocalMax(ps, i) && (top < 0 || ps[i] > ps[top])) top = i;
      if (top < 0) top = argmax(ps, 0, n - 1);
      const P = ov.parent != null ? ov.parent : parentIndex(ps, top, n, noise, notParent);
      const q = { lane, p, ps, a, b, P, noise, ov, parentFixed: ov.parent != null, isEnd: false, products: prm.products,
        cands: productCandidates(ps, P, noise).filter(c => !near(P + c.off)) };
      // The row votes with each lane's automatic bands, so a band removed in one lane does not move the others.
      const autoTop = argmax(ps, 0, n - 1), autoP = parentIndex(ps, autoTop, n, noise);
      q.voteCands = productCandidates(ps, autoP, noise);
      q.autoP = autoP;
      // The uppermost faint band below the well zone: the parent when editing is high enough that it
      // falls under the cut parentIndex uses (about 65% and above; found up to about 87%).
      const reach = reachOf(n), ref = prominence(ps, autoTop, reach), well = Math.max(3, 0.08 * n);
      for (let j = Math.ceil(well); j < autoP - NEAR_BAND; j++) {
        if (isLocalMax(ps, j) && prominence(ps, j, reach) >= Math.max(4 * noise, 0.02 * ref)) { q.faintP = j; q.faintCands = productCandidates(ps, j, noise); break; }
      }
      q.strong = strongPeaks(ps, autoP, n);
      return q;
    });
    // Band positions most lanes share (parents, products, a well, a primer dimer) are not a ladder's
    // signature. A ladder has more strong bands than parent plus two products, most of them its own;
    // keep it out of the vote. Judged on the automatic bands, like the vote.
    const sharedAt = j => pre.length >= 3 && pre.filter(o => o.strong.some(k => Math.abs(k - j) <= SAME_BAND)).length >= Math.max(2, Math.ceil(pre.length / 2));
    pre.forEach(q => {
      q.sharedAt = sharedAt;
      q.ladderLike = !q.lane.role && q.strong.length >= 4 && q.strong.filter(j => !sharedAt(j)).length >= 3;
    });
    const xMin = Math.min(...pre.map(q => q.lane.x)), xMax = Math.max(...pre.map(q => q.lane.x));
    pre.forEach(q => { q.isEnd = q.lane.x === xMin || q.lane.x === xMax; q.rowLanes = pre.length; });
    const autoPre = pre.filter(q => !q.lane.role);
    const ladderLike = autoPre.filter(q => q.ladderLike);
    if (autoPre.length >= 3 && ladderLike.length > autoPre.length / 2) {
      // Most lanes cannot be ladders: they share an extra band (a well or a second PCR product).
      ladderLike.forEach(q => { q.ladderLike = false; q.extraBand = true; });
    }
    const usable = pre.filter(q => q.lane.role !== 'marker' && q.lane.role !== 'excluded' && !q.ladderLike);
    let offsets = null;
    if (usable.length >= 3) {
      offsets = consensusOffsets(usable.map(q => q.voteCands), prm.products);
      const faint = usable.filter(q => q.faintCands);
      if (offsets.length < prm.products && faint.length > usable.length / 2) {
        // Too few shared products and a faint band above most parents: vote again from that band.
        const alt = consensusOffsets(faint.map(q => q.faintCands), prm.products, Math.ceil(usable.length / 2));
        if (alt.length === prm.products) offsets = alt;
      }
      if (offsets.length < prm.products) {
        // Keep the agreed positions and add the next most common ones, seen in at least two lanes.
        const lists = usable.map(q => q.voteCands);
        const extra = consensusOffsets(lists, 8, 2).filter(o => !offsets.some(e => Math.abs(e - o) <= offTol(Math.max(e, o))));
        offsets = offsets.concat(extra).slice(0, prm.products).sort((a, b) => a - b);
      }
      if (offsets.length < prm.products) {
        // Still short (a row with one cut lane): complete it from the strongest further bands of the
        // most cleaved-looking lane, preferring a lane that shows all the products.
        const all = q => q.voteCands.length >= prm.products ? 1 : 0;
        const best = usable.slice().sort((a, b) => all(b) - all(a) || sumProm(b.voteCands) - sumProm(a.voteCands))[0];
        const more = best.voteCands.filter(c => !offsets.some(e => Math.abs(e - c.off) <= offTol(Math.max(e, c.off))))
          .sort((a, b) => b.prom - a.prom).slice(0, prm.products - offsets.length).map(c => c.off);
        offsets = offsets.concat(more).sort((a, b) => a - b);
      }
    }
    const tolOf = offTol;
    if (offsets && offsets.length >= 2) {
      // Both products show in the same cut lanes. A position seen in under half as many lanes as the
      // other is more likely a band of a few lanes (a dimer, a second product): lanes using it warn.
      const support = offsets.map(o => usable.filter(q => q.voteCands.some(c => Math.abs(c.off - o) <= tolOf(o))).length);
      const weak = offsets.filter((o, k) => support[k] < 0.5 * Math.max(...support));
      if (weak.length) pre.forEach(q => { q.weakOffsets = weak; });
    }
    const samePattern = (a, b) => a.length === b.length && a.every((o, k) => Math.abs(o - b[k]) <= tolOf(Math.max(o, b[k])));
    const patterns = offsets && offsets.length ? [offsets] : [];
    if (patterns.length && usable.length >= 3) {
      // Rows can mix amplicons. Lanes whose two strongest lower bands agree form a group, and every
      // group seen in at least two lanes becomes a product pattern besides the row consensus.
      const groups = [];
      usable.forEach(q => {
        const h = q.ps[q.autoP] - minOf(q.ps);
        const own = q.voteCands.filter(c => c.prom >= 0.05 * h).sort((a, b) => b.prom - a.prom).slice(0, prm.products).map(c => c.off).sort((a, b) => a - b);
        if (own.length < prm.products) return;
        const g = groups.find(x => samePattern(x.ref, own));
        if (g) g.items.push(own); else groups.push({ ref: own, items: [own] });
      });
      groups.filter(g => g.items.length >= 2).forEach(g => {
        const pat = g.ref.map((_, k) => median(g.items.map(it => it[k])));
        if (!patterns.some(x => samePattern(x, pat))) patterns.push(pat);
      });
    }
    if (patterns.length) {
      // A further band position shared by half the lanes, not part of any pattern, is not a cleavage product.
      const all = consensusOffsets(usable.map(q => q.voteCands), 8, Math.max(3, Math.ceil(usable.length / 2)));
      const unmatched = all.filter(o => !patterns.some(pat => pat.some(e => Math.abs(e - o) <= tolOf(Math.max(e, o)))));
      usable.forEach(q => { if (unmatched.some(o => q.voteCands.some(c => Math.abs(c.off - o) <= tolOf(o)))) q.extraBand = true; });
      // Each lane takes the pattern and parent that explain its bands best. The parent is the band from
      // which the products sit at the pattern's offsets: this finds a faint parent above about 65%
      // editing and passes over a well or stray band above it. Ladders sit at the ends of a row, so
      // end lanes keep the row consensus.
      pre.forEach(q => {
        if (q.lane.role === 'marker' || q.lane.role === 'excluded' || (q.ladderLike && !q.ov.removed.length)) return;
        let best = null;
        const own = q.ov.removed.length ? q.cands.slice().sort((a, b) => b.prom - a.prom).slice(0, prm.products).map(c => c.off).sort((a, b) => a - b) : [];
        const choices = own.length === prm.products ? patterns.concat([own]) : patterns;
        choices.forEach((pat, k) => {
          const fit = bestParent(q, pat, n);
          if (!best || betterFit(fit.fit, best.fit)) best = { k, pat, P: fit.P, fit: fit.fit };
        });
        if (best.P !== q.P) {
          const near = j => q.ov.removed.some(x => Math.abs(x - j) <= SAME_BAND);
          q.P = best.P;
          q.cands = productCandidates(q.ps, best.P, q.noise).filter(c => !near(best.P + c.off));
        }
        q.patternK = best.k;
        // A lane whose bands a shared pattern explains completely is a sample, even at the end of a row.
        q.fitsPattern = best.fit.hits === best.pat.length && best.fit.left === 0;
        if (best.k > 0) q.ownOffsets = best.pat;
      });
      const uses = patterns.map((_, k) => pre.filter(q => q.patternK === k).length);
      const main = ctx ? ctx.main : uses.indexOf(Math.max(...uses));
      pre.main = main;
      pre.forEach(q => { q.offPattern = q.patternK != null && q.patternK !== main; });
    }
    // With fewer than three lanes there is no majority to vote: each lane uses its own strongest products.
    // At high editing the parent fades and a product can be taken for it: that lane's "parent" then
    // sits a product offset below a parent position nearby lanes share. Only nearby lanes count,
    // since a gel's smile moves parents across the row. Parents of one amplicon line up closely, so
    // this test is held tighter than offTol: within 2 px of each other, 3 px + 5% of the offset.
    const allOffs = patterns.flat();
    const parentOf = o => (ctx ? ctx.P[pre.indexOf(o)] : o.P);   // nearby lanes as found without edits
    const atProduct = (q, offs) => {
      const near = usable.filter(o => o !== q && Math.abs(o.lane.x - q.lane.x) <= 4.5 * pitch).map(parentOf);
      return usable.length >= 3 && near.some(p => q.P - p > NEAR_BAND && near.filter(x => Math.abs(x - p) <= 2).length >= 2 &&
        offs.concat(allOffs).some(off => Math.abs(q.P - p - off) <= 3 + 0.05 * off));
    };
    // A faint parent missed in one lane often shows in its neighbours: as a parent position two nearby
    // lanes share, or as a band two nearby lanes show as their parent or above it. A lane with any real band
    // there, above its own parent, may have taken a product for a faint parent (high editing); with
    // two neighbours agreeing, a band of half the noise counts. So may a lane without products with a
    // band one product offset above its parent. Bands in the well zone at the top of the box do not
    // count. Positions come from the row without edits.
    const reach = reachOf(n), well = Math.ceil(Math.max(3, 0.08 * n));
    const bandAt = (q, u, tol, min) => {
      for (let j = Math.max(well, Math.round(u - tol)); j <= Math.min(q.P - NEAR_BAND - 1, Math.round(u + tol)); j++) {
        if (isLocalMax(q.ps, j) && !q.ov.removed.some(x => Math.abs(x - j) <= SAME_BAND) && prominence(q.ps, j, reach) >= min * Math.min(q.noise, curvatureNoise(q.p))) return true;
      }
      return false;
    };
    const aboveOf = q => {
      const out = [];
      for (let j = well; j < q.P - NEAR_BAND; j++) if (isLocalMax(q.ps, j) && prominence(q.ps, j, reach) >= 2 * q.noise) out.push(j);
      return out;
    };
    // Positions found in two lanes or more; each lane gives a list of positions.
    const common = (lists, tol) => lists.flat().filter(v => lists.filter(l => l.some(w => Math.abs(w - v) <= tol)).length >= 2);
    const nearOf = q => usable.filter(o => o !== q && Math.abs(o.lane.x - q.lane.x) <= 4.5 * pitch);
    // Parent positions that two nearby lanes share.
    const nearParents = ctx ? ctx.nearParents : pre.map(q => (usable.length < 3 ? [] : common(nearOf(q).map(o => [o.P]), 2)));
    const upper = ctx ? ctx.upper : (() => {
      const bands = pre.map(aboveOf);
      // A band above the parent holding a quarter of the parent's height or more counts on its own:
      // that lane's parent is in doubt, and so are lanes with any band there.
      const strong = pre.map((q, i) => bands[i].filter(j => prominence(q.ps, j, reach) >= 0.25 * prominence(q.ps, q.P, reach)));
      return pre.map((q, i) => {
        if (usable.length < 3) return [];
        const near = nearOf(q);
        return nearParents[i].concat(common(near.map(o => [o.P].concat(bands[pre.indexOf(o)])), SAME_BAND), near.flatMap(o => strong[pre.indexOf(o)]));
      });
    })();
    // Parent positions under a strong band above, in a nearby lane: lanes with their parent there too
    // share the doubt even when their own faint parent shows only as a shoulder.
    // So are parent positions where two nearby lanes show any band above.
    const doubted = ctx ? ctx.doubted : pre.map(q => {
      if (usable.length < 3) return [];
      const near = nearOf(q), withAbove = near.filter(o => aboveOf(o).length);
      return near.filter(o => aboveOf(o).some(j => prominence(o.ps, j, reach) >= 0.1 * prominence(o.ps, o.P, reach))).map(o => o.P)
        .concat(withAbove.filter(o => withAbove.filter(w => Math.abs(w.P - o.P) <= SAME_BAND).length >= 2).map(o => o.P));
    });
    const lanes = pre.map((q, i) => {
      let offs = q.ownOffsets || offsets || ownOffsets(q, prm.products);
      // A parent chosen by hand that none of the row's product positions fit (the row learnt them
      // from lanes whose parent was missed): the lane's own strongest products.
      if (q.parentFixed && Math.abs(q.P - q.autoP) > SAME_BAND && offs.length && !offs.some(off => q.cands.some(c => Math.abs(c.off - off) <= offTol(off)))) offs = ownOffsets(q, prm.products);
      const l = analyzeLane(q, offs, n, r, img, prm);
      if (q.offPattern) l.flags.push('product positions differ from the row');
      if (l.role === 'sample' && atProduct(q, offs)) l.flags.push('parent at a product position of the row');
      // Parents of one amplicon line up: a parent well below the one two nearby lanes share is more
      // likely a product taken for a faint parent (high editing), or a different amplicon.
      if (l.role === 'sample' && nearParents[i].some(u => q.P - u >= 10) && !l.flags.includes('parent at a product position of the row')) l.flags.push('parent lower than in nearby lanes');
      if (l.role === 'sample' && !l.flags.includes('band above the parent') &&
          (upper[i].some(u => u < q.P - NEAR_BAND && bandAt(q, u, SAME_BAND, 0.4)) || doubted[i].some(p => Math.abs(p - q.P) <= SAME_BAND) ||
           (!l.found.slice(1).some(Boolean) && offs.some(off => bandAt(q, q.P - off, offTol(off), 1))))) l.flags.push('band above the parent');
      q.offs = offs;
      return l;
    });
    // Two nearby lanes whose parent sits at a product position of the row, at the same place as this
    // lane's parent: this parent is in the same doubt.
    const atProd = ctx ? ctx.atProd : lanes.map((l, i) => (l.flags.includes('parent at a product position of the row') ? pre[i].P : null));
    lanes.forEach((l, i) => {
      const q = pre[i];
      if (l.role !== 'sample' || l.flags.includes('parent at a product position of the row') || l.flags.includes('band above the parent')) return;
      const same = pre.filter((o, j) => j !== i && atProd[j] != null && Math.abs(o.lane.x - q.lane.x) <= 4.5 * pitch && Math.abs(atProd[j] - q.P) <= SAME_BAND);
      if (same.length >= 2) l.flags.push('parent at a product position of the row');
    });
    // Two nearby lanes with the same parent position that warn of a band above it: so does this lane
    // when it reads under 20%, as a lane far cut whose faint parent was missed would.
    const aboveAt = ctx ? ctx.aboveAt : lanes.map((l, i) => (l.flags.includes('band above the parent') ? pre[i].P : null));
    lanes.forEach((l, i) => {
      const q = pre[i];
      if (l.role !== 'sample' || l.flags.includes('band above the parent') || editingGuschin(l.fc) >= 20) return;
      if (pre.filter((o, j) => j !== i && aboveAt[j] != null && Math.abs(o.lane.x - q.lane.x) <= 4.5 * pitch && Math.abs(aboveAt[j] - q.P) <= SAME_BAND).length >= 2) l.flags.push('band above the parent');
    });
    // A nearby lane with its parent well above this one and a clear band where this lane has its
    // parent: this lane's parent is that lane's product, or a band below a faint parent.
    const below = ctx ? ctx.below : pre.map((q, i) => usable.includes(q) && nearOf(q).some(o => o.P < q.P - 10 && !upper[pre.indexOf(o)].some(u => u < o.P - NEAR_BAND) &&
      o.cands.some(c => Math.abs(o.P + c.off - q.P) <= SAME_BAND && c.prom >= 0.1 * (o.ps[o.P] - minOf(o.ps)))));
    lanes.forEach((l, i) => {
      if (l.role === 'sample' && below[i] && !l.flags.includes('parent at a product position of the row')) l.flags.push('parent at a product position of the row');
    });
    // One product, yet lanes show a band at a product position of the row with a further band above
    // it, or no product where expected and a band above that place. Two such lanes with the further
    // band at the same position (or one, with a strong band) mean the row cannot tell which band is
    // the cleavage product and which a primer dimer (a dimer shows in uncut lanes too): every cut lane
    // with that position above its product warns. Lanes whose parent may be a product do not count.
    // Positions come from the row without edits. Not used with two products: there it flagged most
    // lanes of rows that mix amplicons; there product 2 brighter than product 1 warns instead.
    const above = (offs, off) => offs.length === 1 && off > NEAR_BAND && off < offs[0] - offTol(offs[0]);
    const cut = i => lanes[i].found.slice(1).some(Boolean);
    const lower = ctx ? ctx.lower : (() => {
      if (usable.length < 3 || prm.products !== 1) return [];
      const lists = usable.map(q => pre.indexOf(q)).filter(i => !upper[i].some(u => u < pre[i].P - NEAR_BAND)).map(i => {
        const q = pre[i], bands = q.cands.filter(c => c.prom >= Math.max(4 * q.noise, 0.04 * (q.ps[q.P] - minOf(q.ps))));
        const at = allOffs.filter(o => bands.some(c => Math.abs(c.off - o) <= offTol(o))).concat(cut(i) ? [] : q.offs);
        return bands.filter(c => at.some(o => above([o], c.off))).map(c => Object.assign({ strong: c.prom >= 0.1 * (q.ps[q.P] - minOf(q.ps)) }, c));
      });
      // One lane is enough when its further band is strong: a row with a single cut lane.
      // A product pattern of two lanes or more above the main one, and a lane whose parent sits well
      // below the parent nearby lanes share (its band is then a product that far below), say the same.
      const sure = (q, i) => !upper[i].some(u => u < q.P - NEAR_BAND);
      const others = patterns.filter((pat, k) => k !== pre.main && pre.filter((q, i) => q.patternK === k && sure(q, i)).length >= 2).map(pat => pat[0]);
      const shifted = pre.flatMap((q, i) => nearParents[i].filter(u => q.P - u >= 10).map(u => q.P - u));
      return consensusOffsets(lists, 8, 2).concat(consensusOffsets(lists.map(l => l.filter(c => c.strong)), 8, 1), others, shifted);
    })();
    lanes.forEach((l, i) => {
      if (l.role === 'sample' && cut(i) && lower.some(o => above(pre[i].offs, o)) && !l.flags.includes('check band assignment')) l.flags.push('check band assignment');
    });

    // Lanes of one product pattern find each product at about the same distance below their parent.
    // When those distances fall into two groups well apart, one group took another band (a primer
    // dimer, a second product) for the product, and that group warns.
    const split = ctx ? ctx.split : (() => {
      const out = new Set();
      const groups = new Map();
      pre.forEach((q, i) => { if (lanes[i].role === 'sample' && q.offs && q.offs.length) { const g = groups.get(q.offs) || []; g.push(i); groups.set(q.offs, g); } });
      for (const idx of groups.values()) {
        if (idx.length < 4) continue;
        for (let k = 1; k <= prm.products; k++) {
          // Products of 3% of the lane or more: a faint band near the noise may sit anywhere.
          const solid = i => lanes[i].found[k] && lanes[i].areas[k] >= 0.03 * lanes[i].areas.reduce((s, v) => s + v, 0);
          const at = idx.filter(solid).map(i => ({ i, off: lanes[i].peaks[k] - lanes[i].peaks[0] })).sort((a, b) => a.off - b.off);
          if (at.length < 4) continue;
          let cut = -1, gap = 0;
          for (let j = 1; j < at.length; j++) if (at[j].off - at[j - 1].off > gap) { gap = at[j].off - at[j - 1].off; cut = j; }
          if (cut < 0) continue;
          const lo = at.slice(0, cut), hi = at.slice(cut);
          if (gap <= Math.max(2 * SAME_BAND, offTol(at[cut - 1].off)) || lo.length < 2 || hi.length < 2) continue;
          // A primer dimer shows in uncut lanes too: the group holding lanes that lack the other
          // product is the one that took it. Otherwise the smaller group, both when equal.
          const alone = g => g.filter(x => lanes[x.i].found.slice(1).filter(Boolean).length === 1).length;
          const pickG = prm.products === 2 && alone(lo) !== alone(hi) ? (alone(lo) > alone(hi) ? lo : hi)
            : lo.length < hi.length ? lo : hi.length < lo.length ? hi : at;
          pickG.forEach(x => out.add(x.i));
        }
      }
      return Array.from(out);
    })();
    split.forEach(i => { if (!lanes[i].flags.includes('check band assignment')) lanes[i].flags.push('check band assignment'); });
    const auto = lanes.filter(l => l.autoRole);
    const autoMarkers = auto.filter(l => l.role === 'marker' && !l.ladderLike);
    if (auto.length >= 3 && autoMarkers.length > auto.length / 2) {
      // Most lanes cannot be ladders: the extra band is shared (a primer dimer or second PCR product).
      autoMarkers.forEach(l => { l.role = 'sample'; l.flags.push('extra band not matching the cleavage products'); });
    }
    // One product and three lanes or fewer: an uncut lane with a primer dimer looks like a lane cut
    // up to about 20%, and a lane cut above about 75% whose parent shows only as a shoulder looks
    // uncut. With so few lanes the row cannot tell them apart, so lanes reading under 20% say so.
    if (prm.products === 1 && usable.length <= 3) {
      lanes.forEach(l => { if (l.role === 'sample' && editingGuschin(l.fc) < 20) l.flags.push('one product and few lanes: bands not cross-checked'); });
    }
    const samples = lanes.filter(l => l.role === 'sample');
    const brighter = samples.filter(l => l.flags.includes('cleavage product brighter than parent'));
    const brighterRow = ctx ? ctx.brighterRow : samples.length >= 3 && brighter.length > samples.length / 2;
    // Rare in a real row; usually the box includes wells or a band above the parents.
    if (brighterRow) brighter.forEach(l => { if (!l.flags.includes('check band assignment')) l.flags.push('check band assignment'); });
    const context = { main: pre.main, P: pre.map(q => q.P), brighterRow, upper, lower, nearParents, doubted, split, atProd, below, aboveAt };
    return { region: r, pitch, half, offsets: offsets || [], shared: !!(offsets && offsets.length), lanes, context };
  }

  /**
   * Fit comparison: more products found; then fewer strong bands left unexplained; then, when the
   * pattern is complete, a closer fit. Remaining ties go to the upper band (see bestParent).
   */
  function betterFit(a, b) {
    if (a.hits !== b.hits) return a.hits > b.hits;
    if (a.hits === 0) return false;
    if (a.left !== b.left) return a.left < b.left;
    return a.complete && a.dev < b.dev - 1;
  }

  /** Parent candidate whose product offsets match the most bands; ties keep the first-pass choice. */
  function bestParent(q, offsets, n) {
    const { ps, noise } = q;
    const reach = reachOf(n);
    const top = argmax(ps, 0, n - 1);
    const ref = prominence(ps, top, reach);
    const removed = j => q.ov && q.ov.removed.some(x => Math.abs(x - j) <= SAME_BAND);
    const hand = j => removed(j) || (q.ov && q.ov.products.some(x => x != null && Math.abs(x - j) <= SAME_BAND));
    const cands = [q.P].concat(hand(top) ? [] : [top], q.faintP != null && !hand(q.faintP) ? [q.faintP] : []);
    for (let j = 1; j < n - 1; j++) {
      if (j !== q.P && j !== top && !hand(j) && isLocalMax(ps, j) && prominence(ps, j, reach) >= Math.max(4 * noise, 0.05 * ref)) cands.push(j);
    }
    // Score: products found at the shared offsets; then fewer strong bands below the parent left
    // unexplained (a well or smear taken as parent leaves the real product 2 over); then a closer fit.
    const strong = [];
    for (let j = 1; j < n - 1; j++) if (!removed(j) && isLocalMax(ps, j) && prominence(ps, j, reach) >= Math.max(4 * noise, 0.15 * ref)) strong.push(j);
    const well = Math.max(3, 0.08 * n);   // smear from a well at the top of the box does not count against a parent
    const score = P => {
      const acc = offsets.reduce((a, off) => {
        const tol = offTol(off);
        let dev = Infinity;
        for (let j = Math.max(1, Math.round(P + off - tol)); j <= Math.min(n - 2, Math.round(P + off + tol)); j++) {
          if (!removed(j) && isLocalMax(ps, j) && prominence(ps, j, reach) >= 3 * noise) dev = Math.min(dev, Math.abs(j - P - off));
        }
        return isFinite(dev) ? { hits: a.hits + 1, dev: a.dev + dev } : a;
      }, { hits: 0, dev: 0 });
      // Strong bands the choice leaves unexplained: below the parent and off the pattern, or above it.
      acc.left = strong.filter(j => (j > P + NEAR_BAND && !offsets.some(off => Math.abs(j - P - off) <= offTol(off))) || (j < P - NEAR_BAND && j >= well)).length;
      acc.complete = offsets.length >= (q.products || 2);
      return acc;
    };
    let best = q.parentFixed ? q.P : q.P, bestScore = score(q.P);
    if (q.parentFixed) return { P: best, fit: bestScore };
    for (const c of cands) {
      const sc = score(c);
      // Equal support and fit: the upper band is the parent (a faint parent above about 65% editing).
      if (betterFit(sc, bestScore) || (sc.hits === bestScore.hits && sc.hits > 0 && !betterFit(bestScore, sc) && c < best)) { best = c; bestScore = sc; }
    }
    return { P: best, fit: bestScore };
  }

  function sumProm(c) { return c.reduce((s, x) => s + x.prom, 0); }

  /**
   * The parent is the uppermost strong band: above about 37% editing the
   * larger cleavage product is brighter than the uncut band.
   */
  function parentIndex(ps, top, n, noise, skip) {
    const reach = reachOf(n);
    const ref = prominence(ps, top, reach);
    for (let j = 1; j < top - NEAR_BAND; j++) {
      if (!isLocalMax(ps, j) || (skip && skip(j))) continue;
      const pr = prominence(ps, j, reach);
      if (pr >= 0.2 * ref && pr >= 4 * noise) return j;
    }
    return top;
  }

  /**
   * Profile with removed bands taken out: each is modelled as a Gaussian with its own height above
   * the local floor and a width from its cleaner (narrower) half-maximum flank, then subtracted.
   */
  /** Solve the small dense system A x = b (Gaussian elimination with partial pivoting); null if singular. */
  function solveSmall(A, b) {
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
    return x;
  }

  /**
   * Areas of the bands at `centers`, fitted on p[y0..y1] as a straight baseline plus one Gaussian per
   * band (Levenberg-Marquardt). Centres may move 3 px; widths stay between 0.8 px and 4 x `sd0`.
   */
  function fitBandAreas(p, y0, y1, centers, sd0) {
    const ys = [];
    for (let y = y0; y <= y1; y++) ys.push(y);
    const lo = Math.min(p[y0], p[y1]), nb = centers.length;
    let x = [lo, 0];
    centers.forEach(c => { x.push(Math.max(1e-3, p[c] - lo), c, sd0); });
    const clamp = v => {
      for (let k = 0; k < nb; k++) {
        const i = 2 + 3 * k;
        v[i] = Math.max(0, v[i]);
        v[i + 1] = Math.min(centers[k] + 3, Math.max(centers[k] - 3, v[i + 1]));
        v[i + 2] = Math.min(4 * sd0, Math.max(0.8, v[i + 2]));
      }
      return v;
    };
    const model = (v, y) => {
      let s = v[0] + v[1] * (y - y0);
      for (let k = 0; k < nb; k++) { const i = 2 + 3 * k; s += v[i] * Math.exp(-((y - v[i + 1]) ** 2) / (2 * v[i + 2] ** 2)); }
      return s;
    };
    const cost = v => ys.reduce((s, y) => s + (p[y] - model(v, y)) ** 2, 0);
    let lam = 1e-2, c0 = cost(x);
    const m = x.length;
    for (let it = 0; it < 60; it++) {
      // Normal equations from the exact derivatives of the model.
      const A = Array.from({ length: m }, () => new Array(m).fill(0)), g = new Array(m).fill(0), row = new Array(m);
      for (const y of ys) {
        let f = x[0] + x[1] * (y - y0);
        row[0] = 1; row[1] = y - y0;
        for (let k = 0; k < nb; k++) {
          const i = 2 + 3 * k, a = x[i], mu = x[i + 1], sd = x[i + 2], u = (y - mu) / sd, e = Math.exp(-u * u / 2);
          f += a * e;
          row[i] = e; row[i + 1] = a * e * u / sd; row[i + 2] = a * e * u * u / sd;
        }
        const r = p[y] - f;
        for (let a = 0; a < m; a++) { g[a] += row[a] * r; for (let b = a; b < m; b++) A[a][b] += row[a] * row[b]; }
      }
      for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
      let improved = false;
      for (let tries = 0; tries < 8 && !improved; tries++) {
        const d = solveSmall(A.map((r, i) => r.map((v, j) => (i === j ? v * (1 + lam) + 1e-9 : v))), g);
        if (!d) { lam *= 10; continue; }
        const xn = clamp(x.map((v, i) => v + d[i])), cn = cost(xn);
        if (cn < c0) { improved = c0 - cn > 1e-9 * c0; x = xn; c0 = cn; lam = Math.max(1e-6, lam / 3); if (!improved) break; } else lam *= 10;
      }
      if (!improved) break;
    }
    return centers.map((_, k) => { const i = 2 + 3 * k; return x[i] * x[i + 2] * Math.sqrt(2 * Math.PI); });
  }

  function withoutBands(ps, idx) {
    const out = Float32Array.from(ps), n = ps.length;
    idx.forEach(m => {
      let l = m, r = m;
      while (l > 0 && ps[l - 1] < ps[l]) l--;
      while (r < n - 1 && ps[r + 1] < ps[r]) r++;
      const floor = Math.min(ps[l], ps[r]);   // the lower flank: the other may be cut by the box or lifted by a neighbour
      const amp = ps[m] - floor;
      if (!(amp > 0)) return;
      const half = floor + amp / 2;
      let a = m, b = m;
      while (a > l && ps[a] > half) a--;
      while (b < r && ps[b] > half) b++;
      // Half-maximum crossings interpolated between pixels; the side not lifted by a neighbour sets the width.
      const left = a < m && ps[a] <= half ? a + (half - ps[a]) / (ps[a + 1] - ps[a]) : a;
      const right = b > m && ps[b] <= half ? b - (half - ps[b]) / (ps[b - 1] - ps[b]) : b;
      const hw = Math.max(1, Math.min(m - left, right - m));
      const sigma = hw / 1.1774;
      for (let i = Math.max(0, Math.floor(m - 5 * sigma)); i <= Math.min(n - 1, Math.ceil(m + 5 * sigma)); i++) {
        out[i] -= amp * Math.exp(-((i - m) ** 2) / (2 * sigma * sigma));
      }
    });
    return out;
  }

  /** Local maxima that stand at least three times the noise above their surroundings. */
  function peakList(ps, noise) {
    const reach = Math.max(10, Math.round(ps.length / 4)), out = [];
    for (let j = 1; j < ps.length - 1; j++) if (isLocalMax(ps, j) && prominence(ps, j, reach) >= 3 * noise) out.push(j);
    return out;
  }

  function ownOffsets(q, k) {
    return q.cands.slice().sort((a, b) => b.prom - a.prom).slice(0, k).map(c => c.off).sort((a, b) => a - b);
  }

  /** Local maxima (including the parent) with at least a quarter of the parent's height. */
  function strongPeaks(ps, P, n) {
    const parentProm = ps[P] - minOf(ps);
    const out = [P];
    for (let j = 1; j < n - 1; j++) {
      if (Math.abs(j - P) <= NEAR_BAND || !isLocalMax(ps, j)) continue;
      if (prominence(ps, j, reachOf(n)) >= 0.25 * parentProm) out.push(j);
    }
    return out;
  }

  function analyzeLane(q, offsets, n, r, img, prm) {
    const { ps, P, noise, ov } = q;
    const flags = [];
    const parentProm = ps[P] - minOf(ps);
    const nearRemoved = i => ov.removed.some(j => Math.abs(j - i) <= SAME_BAND);
    if (ov.any) flags.push('manual band assignment');
    // Bands chosen by hand are reserved: automatic products never take them a second time.
    const reserved = [q.parentFixed ? P : null].concat(ov.products).filter(i => i != null);
    const taken = (i, k) => reserved.some((j, r) => Math.abs(j - i) <= SAME_BAND && !(r > 0 && ov.products[r - 1] != null && r - 1 === k));

    // Products at the consensus offsets relative to this lane's own parent (handles tilt and smile).
    // A product chosen by hand wins; a removed band is never picked.
    const slots = ov.products.some(i => i != null) ? prm.products : Math.min(offsets.length, prm.products);
    const prods = [];
    for (let k = 0; k < slots; k++) {
      const fixed = ov.products[k];
      if (fixed != null) { prods.push({ y: fixed, found: true, fixed: true }); continue; }
      const off = offsets[k];
      if (off == null) {
        // No expected position (only hand-set products later on): hold the slot without a band of its own.
        const next = ov.products.slice(k + 1).find(v => v != null);
        prods.push({ y: Math.round((P + (next != null ? next : n - 1)) / 2), found: false, slotOnly: true });
        continue;
      }
      const lo = k === 0 ? Math.max(P + 3, P + off - offTol(off)) : P + (offsets[k - 1] + off) / 2;
      const hi = k === offsets.length - 1 ? P + off + offTol(off) : P + (off + offsets[k + 1]) / 2;
      let c = -1;
      for (let i = Math.max(0, Math.round(lo)); i <= Math.min(n - 1, Math.round(hi)); i++) {
        if (!nearRemoved(i) && !taken(i, k) && (c < 0 || ps[i] > ps[c])) c = i;
      }
      if (ov.removed.length && !(c > Math.round(lo) && c < Math.round(hi) && isLocalMax(ps, c))) {
        // Next to a removed band the window maximum can be that band's tail: take the highest real peak instead.
        let best = -1;
        for (let i = Math.max(1, Math.round(lo) + 1); i < Math.min(n - 1, Math.round(hi)); i++) {
          if (!nearRemoved(i) && !taken(i, k) && isLocalMax(ps, i) && (best < 0 || ps[i] > ps[best])) best = i;
        }
        if (best > 0) c = best;
      }
      // Flat background or a noise ripple passes as a local maximum: a product must stand above the
      // noise. The same test for every lane, so a hand edit that confirms a band changes nothing.
      const solid = prominence(ps, c, Math.max(8, c - P)) >= noise;
      const found = c > P && c < n - 1 && isLocalMax(ps, c) && c > Math.round(lo) && c < Math.round(hi) && solid;
      prods.push({ y: found ? c : Math.min(n - 1, Math.round(P + off)), found });
    }

    // Bands in gel order: parent, products and removed bands inside the measured range.
    const peaks = [P].concat(prods.map(x => x.y));
    const lowest = Math.max(...peaks);
    // Removed bands inside the measured range, including one just above the parent (for example a
    // heteroduplex first taken as parent), get their own excluded segment.
    const above = 1.5 * (peaks.length > 1 ? peaks[1] - P : Math.max(6, Math.round(n * 0.15)));
    const sortedPeaks = peaks.slice().sort((a, b) => a - b);
    const below = 1.5 * (sortedPeaks.length > 1 ? sortedPeaks[sortedPeaks.length - 1] - sortedPeaks[sortedPeaks.length - 2] : above);
    // An undetected product only marks where it was expected; when that spot is another band it gets no segment.
    const collides = (y, i) => peaks.some((o, j) => j !== i && Math.abs(o - y) <= SAME_BAND) || nearRemoved(y);
    const bands = peaks.map((y, i) => ({ y, kind: i })).filter(b => b.kind === 0 || prods[b.kind - 1].found || (!prods[b.kind - 1].slotOnly && !collides(b.y, b.kind)))
      .concat(ov.removed.filter(y => y > P - above && y < lowest + below && !peaks.some((p, i) => (i === 0 || prods[i - 1].found) && Math.abs(p - y) <= SAME_BAND)).map(y => ({ y, kind: -1 })))
      .sort((a, b) => a.y - b.y || a.kind - b.kind);
    const ys = bands.map(b => b.y);
    const removedIn = bands.filter(b => b.kind < 0).map(b => b.y);
    const pm = removedIn.length ? withoutBands(ps, removedIn) : ps;   // profile used for valleys and areas
    let valleys;
    const manual = !!(q.lane.valleys && q.lane.valleys.length === bands.length + 1);
    if (manual) {
      valleys = q.lane.valleys.map(v => Math.min(n - 1, Math.max(0, Math.round(v - r.y0)))).sort((a, b) => a - b);
      flags.push('manual band boundaries');
      const measured = b => b.kind === 0 || (b.kind > 0 && prods[b.kind - 1].found);   // not the place an undetected product was expected
      if (bands.some((b, s) => measured(b) && !(valleys[s] < b.y && b.y < valleys[s + 1]))) flags.push('band boundary crosses a band');
    } else {
      if (q.lane.valleys) flags.push('manual band boundaries ignored: the number of bands changed');
      const firstGap = ys.length > 1 ? ys[1] - ys[0] : Math.max(6, Math.round(n * 0.15));
      valleys = [argmin(pm, ys[0] - firstGap, ys[0])];
      for (let i = 0; i < ys.length - 1; i++) valleys.push(argmin(pm, ys[i], ys[i + 1]));
      const lastGap = ys.length > 1 ? ys[ys.length - 1] - ys[ys.length - 2] : firstGap;
      valleys.push(argmin(pm, ys[ys.length - 1], ys[ys.length - 1] + lastGap));
      for (let i = 1; i < valleys.length; i++) if (valleys[i] < valleys[i - 1]) valleys[i] = valleys[i - 1];
    }

    const nodes = baselineNodes(pm, valleys, prm.background, prm.blendK);
    const baseline = interpBaseline(n, valleys, nodes);
    const areas = peaks.map(() => 0);
    for (let s = 0; s < valleys.length - 1; s++) {
      let sum = 0;
      const end = s === valleys.length - 2 ? valleys[s + 1] : valleys[s + 1] - 1;
      for (let i = valleys[s]; i <= end; i++) sum += Math.max(0, pm[i] - baseline[i]);
      if (bands[s].kind >= 0) areas[bands[s].kind] = sum;   // a removed band's area is not counted
    }
    const segKinds = bands.map(b => b.kind);
    // A removed band that runs into a measured band cannot be separated cleanly: say so.
    if (removedIn.length) {
      const floor = minOf(ps);
      for (let s = 0; s < bands.length; s++) {
        if (bands[s].kind >= 0) continue;
        [s - 1, s + 1].forEach(t => {
          if (t < 0 || t >= bands.length || bands[t].kind < 0) return;
          const v = valleys[Math.max(s, t)];   // the boundary shared by the two segments
          const lower = Math.min(ps[bands[s].y], ps[bands[t].y]) - floor;
          if (lower > 0 && ps[v] - floor > 0.5 * lower && !flags.includes('removed band overlaps a measured band')) flags.push('removed band overlaps a measured band');
        });
      }
    }
    prods.forEach((x, k) => {
      // No band, no area: also when the boundaries were set by hand.
      if (!x.found) { areas[k + 1] = 0; flags.push('product ' + (k + 1) + ' not detected'); }
    });

    const heights = peaks.map((y, i) => ps[y] - (isNaN(baseline[y]) ? nodes[Math.min(i, nodes.length - 1)] : baseline[y]));
    const faint = prods.map((x, k) => x.found && !x.fixed && heights[k + 1] < prm.faintSNR * noise);
    if (prods.length === 2 && prods[0].found !== prods[1].found && faint[0] !== faint[1]) {
      // A single faint "product" without its partner is noise, as in an uncut control.
      const k = faint[0] ? 0 : 1;
      prods[k].found = false; faint[k] = false; areas[k + 1] = 0;
      flags.push('product ' + (k + 1) + ' not detected');
    }
    prods.forEach((x, k) => { if (faint[k]) flags.push('product ' + (k + 1) + ' faint'); });
    if (!offsets.length && !prods.some(x => x.found)) flags.push('no cleavage products found');
    // No products, yet a faint band above the parent: at high editing that band is the parent.
    if (!prods.some(x => x.found) && q.faintP != null && q.faintP < P - NEAR_BAND && !nearRemoved(q.faintP)) flags.push('band above the parent');
    if (q.weakOffsets && prods.some((x, k) => x.found && offsets[k] != null && q.weakOffsets.includes(offsets[k]))) flags.push('check band assignment');
    // Cleavage always yields both fragments: one without the other points to a non-specific band.
    if ((prods.length === 2 && prods[0].found !== prods[1].found) ||
        (prm.products === 2 && prods.length === 1 && prods[0].found)) flags.push('only one cleavage product found');
    if (P !== argmax(pm, 0, n - 1)) flags.push('cleavage product brighter than parent');
    if (prm.products === 1 && offsets.length === 1 &&
        q.cands.some(c => c.off > offsets[0] + offTol(offsets[0]) && c.prom >= 0.1 * parentProm)) {
      flags.push('second product visible: set two products');
    }

    const sat = clippedShare(img, prm.polarity, q.a, q.b, r.y0 + P);
    if (sat > prm.satFraction) flags.push('parent saturated');
    if (prods.some(x => x.found && clippedShare(img, prm.polarity, q.a, q.b, r.y0 + x.y) > prm.satFraction)) flags.push('product saturated');
    if (ps[argmax(ps, 0, n - 1)] - minOf(ps) < Math.max(8 * noise, 10)) flags.push('weak lane');

    // Automatic role: a ladder has strong bands that match neither the parent nor the products.
    {
      const lo = minOf(ps), hP = ps[P] - lo, last = valleys[valleys.length - 1], reach = reachOf(n);
      const lastHeight = Math.max(heights[heights.length - 1], noise);
      // A boundary at the end of the profile while the signal is still sloping there means the box cut a band tail.
      // Pixel noise from curvature: a short box full of band flanks would inflate the slope-based estimate.
      // The edge level is read from the smoothed profile, so it is judged against that profile's own noise.
      const en = Math.max(1e-3, curvatureNoise(q.p)), enS = Math.max(1e-3, curvatureNoise(ps));
      const topCut = valleys[0] <= 1 && n > 4 && ps[3] - ps[0] > 3 * en && ps[0] - lo > Math.max(0.04 * hP, 3 * enS);
      const bottomCut = last >= n - 2 && n > 4 && ps[n - 4] - ps[n - 1] > 3 * en && ps[n - 1] - lo > Math.max(0.04 * lastHeight, 3 * enS);
      if (P <= 1 || (valleys[0] <= 1 && ps[0] - lo > 0.2 * hP) || topCut || bottomCut || (last >= n - 2 && ps[n - 1] - lo > 0.5 * lastHeight + 3 * noise)) {
        flags.push('band cut by the box edge');
      } else if (P <= Math.max(3, 0.06 * n)) {
        flags.push('band at the top of the box: a well?');
      }
      const isPeak = j => peaks.some(y => Math.abs(y - j) <= NEAR_BAND) || nearRemoved(j);
      // Look a little below the last measured band too: a real product can be pushed out of the range.
      // With a product missing, the band it should have been may sit anywhere below: look to the end.
      const lastY = Math.max(...peaks), tail = prods.some(x => !x.found) ? n - 2 : Math.min(n - 2, Math.round(lastY + 0.6 * (lastY - P)));
      for (let j = valleys[0] + 1; j <= Math.max(last - 1, tail); j++) {
        if (!isPeak(j) && isLocalMax(ps, j) && prominence(ps, j, reach) >= Math.max(4 * noise, 0.04 * hP)) { flags.push('unassigned band inside the measured range'); break; }
      }
      const ref = prominence(ps, argmax(ps, 0, n - 1), reach), none = !prods.some(x => x.found), well = Math.max(3, 0.08 * n);
      // Without products, any band above the well zone that stands out of the noise may be a faint
      // parent at very high editing: the lane then reads 0% instead of over 80%. A row of one or two
      // lanes has no neighbours to show that parent, so there any band above the noise counts.
      // The slope-based noise grows with the flanks of strong bands; a short row uses the smaller
      // curvature-based estimate as well.
      const few = q.rowLanes <= 3, faintBar = few ? 0.3 * Math.min(noise, curvatureNoise(q.p)) : 2 * noise;
      for (let j = 1; j < P - NEAR_BAND && !flags.includes('band above the parent'); j++) {
        if (nearRemoved(j) || !isLocalMax(ps, j)) continue;
        const pr = prominence(ps, j, reach);
        if (pr >= Math.max(3 * noise, 0.05 * ref) || ((none || few) && j >= well && pr >= faintBar)) flags.push('band above the parent');
      }
      if (q.extraBand) flags.push('extra band not matching the cleavage products');
    }
    let role = q.lane.role;
    if (!role && ov.any) role = 'sample';   // bands chosen by hand: the user treats this lane as a sample
    if (!role) {
      // Ladders sit at the ends of a row, or make up a row of one or two lanes. A ladder-like lane
      // inside the row is a sample with an extra band. An end lane is a ladder when strong bands that
      // neither its parent, its products nor a band most lanes share explain are left over.
      const endish = q.isEnd || q.rowLanes < 3;
      const explained = j => Math.abs(j - P) <= NEAR_BAND || q.sharedAt(j) || offsets.some(off => Math.abs(j - P - off) <= offTol(off)) ||
        (prm.products === 1 && offsets.length === 1 && j - P > offsets[0]);   // the second product, not a ladder band
      let left = 0;
      for (let j = 1; endish && !q.ladderLike && !q.fitsPattern && j < n - 1; j++) {
        if (isLocalMax(ps, j) && !explained(j) && prominence(ps, j, reachOf(n)) >= 0.25 * parentProm) left++;
      }
      if (q.ladderLike && !endish) flags.push('extra band not matching the cleavage products');
      role = (q.ladderLike ? endish : left > 0) ? 'marker' : 'sample';
    }

    const total = areas.reduce((s, v) => s + v, 0);
    const fc = total > 0 ? (total - areas[0]) / total : 0;
    if (fc === 0 && offsets.length && role === 'sample') flags.push('no cleavage');
    // A lane reading under 20% with any band above its parent that stands out of the noise: at very
    // high editing the parent fades to such a band and a product is read as the parent.
    if (role === 'sample' && editingGuschin(fc) < 20 && !flags.includes('band above the parent')) {
      const well = Math.max(3, 0.08 * n), reach = reachOf(n);
      for (let j = Math.ceil(well); j < P - NEAR_BAND; j++) {
        if (!nearRemoved(j) && isLocalMax(ps, j) && prominence(ps, j, reach) >= noise) { flags.push('band above the parent'); break; }
      }
    }

    if (fc > 0 && role === 'sample') {
      // Bands that run into each other: products on the tail of the parent lose most of their area
      // to a baseline through the valleys. Measure again on a straight line between the outer
      // boundaries; when the two disagree strongly, the result depends on the baseline.
      const v0 = valleys[0], vN = valleys[valleys.length - 1];
      const outer = i => (vN > v0 ? pm[v0] + (pm[vN] - pm[v0]) * (i - v0) / (vN - v0) : pm[v0]);
      const alt = areas.map(() => 0);
      for (let s = 0; s < valleys.length - 1; s++) {
        const end = s === valleys.length - 2 ? valleys[s + 1] : valleys[s + 1] - 1;
        let sum = 0;
        for (let i = valleys[s]; i <= end; i++) sum += Math.max(0, pm[i] - outer(i));
        if (bands[s].kind >= 0 && areas[bands[s].kind] > 0) alt[bands[s].kind] = sum;
      }
      const altTotal = alt.reduce((s, v) => s + v, 0);
      // Both fragments come from the same cut molecules, so the shorter one (product 2) carries less
      // dye than the longer one. Product 2 well above product 1 on both baselines is more likely a
      // primer dimer or a second PCR product than a cleavage product.
      if (prods.length === 2 && prods[0].found && prods[1].found && areas[1] + areas[2] >= 0.15 * total &&
          ((areas[2] > areas[1] && alt[2] > alt[1]) || (q.rowLanes <= 3 && areas[2] > 1.3 * areas[1])) && !flags.includes('check band assignment')) flags.push('check band assignment');
      const e1 = editingGuschin(fc), e2 = altTotal > 0 ? editingGuschin((altTotal - alt[0]) / altTotal) : e1;
      const d = Math.abs(e1 - e2);
      // Also when product 2, which carries less dye than product 1, measures at least as much: then
      // a band below has likely run into it, and the value hangs on where the baseline cuts.
      let overlap = d >= OVERLAP.large || (d >= OVERLAP.points && Math.max(e1, e2) >= OVERLAP.ratio * Math.min(e1, e2)) ||
        (d >= OVERLAP.points && areas.length === 3 && areas[2] >= areas[1] && areas[1] > 0);
      // A second opinion that separates touching bands: one Gaussian per measured band on a straight
      // baseline. It is not used as the value (saturated or smeared bands are not Gaussian), only to
      // say when the value depends on how touching bands are split.
      const meas = peaks.filter((y, k) => k === 0 || prods[k - 1].found);
      if (!overlap && meas.length >= 2) {
        const fit = fitBandAreas(pm, v0, vN, meas, Math.max(1.5, (vN - v0) / (6 * meas.length)));
        const fitTotal = fit.reduce((s, v) => s + v, 0);
        if (fitTotal > 0 && Math.abs(editingGuschin((fitTotal - fit[0]) / fitTotal) - e1) >= OVERLAP.fit) overlap = true;
      }
      if (overlap) flags.push('bands overlap: result depends on the baseline');
    }

    return {
      x: q.lane.x, a: q.a, b: q.b, y0: r.y0,
      profile: ps, corrected: removedIn.length ? pm : null, baseline, valleys, peaks, found: [true].concat(prods.map(x => x.found)), segKinds,
      fixed: [q.parentFixed].concat(prods.map(x => !!x.fixed)), removed: ov.removed.slice(), candidates: peakList(ps, noise),
      areas, heights, fc, role, flags, noise, saturated: sat, parentProm,
      autoRole: !q.lane.role, ladderLike: !!q.ladderLike, edited: !!ov.any,
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
    let ncSaturated = 0;
    out.forEach(r => r.lanes.forEach(l => {
      if (l.role !== 'nc') return;
      if (l.flags.includes('parent saturated')) ncSaturated++;   // a clipped control overstates background cutting
      else nc.push(l.fc);
    }));
    const ncFc = nc.length ? nc.reduce((s, v) => s + v, 0) / nc.length : 0;
    out.forEach(r => r.lanes.forEach(l => {
      l.flags = Array.from(new Set(l.flags));
      if (l.role === 'marker' || l.role === 'excluded') { l.editing = NaN; l.flags = []; return; }
      l.fcCorrected = prm.subtractNC && l.role === 'sample' ? Math.max(0, l.fc - ncFc) : l.fc;
      l.editing = editing(l.fcCorrected, prm.formula);
      if (prm.formula === 'single' && l.fcCorrected > 0.5) l.flags.push('fraction cleaved > 0.5: single-allele model invalid');
    }));
    if (prm.smoothing > DEFAULTS.smoothing + 0.5) {
      // Heavy smoothing merges band shoulders, and every other check looks at the same smoothed
      // profile: compare with the default smoothing.
      const ref = analyze(img, rows, Object.assign({}, prm, { smoothing: DEFAULTS.smoothing }), sig);
      out.forEach((r, ri) => r.lanes.forEach((l, li) => {
        const e = ref.rows[ri].lanes[li];
        if (l.role === 'sample' && e && e.role === 'sample' && Math.abs(l.editing - e.editing) >= 2) l.flags.push('result depends on the smoothing');
      }));
    }
    return { rows: out, ncFc, ncCount: nc.length, ncSaturated };
  }

  return {
    DEFAULTS, ROLES, WARNINGS, isWarning, SAME_BAND,
    rgbaToGray, makeImage, detectPolarity, signalImage,
    smooth, opening, noiseSigma, median, estimatePitch,
    detectLanes, laneProfile, analyzeRow, analyze,
    editingGuschin, editingSingle, editing
  };
});
