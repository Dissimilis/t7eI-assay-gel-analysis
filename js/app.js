/* T7E1 Gel Analysis: user interface. Depends on analysis.js, tiff.js and sample.js. */
(function () {
  'use strict';

  const T = window.T7E1, TIFF = window.T7E1Tiff, SAMPLE = window.T7E1Sample, XLSX = window.T7EIXlsx;
  const VERSION = '1.8.0';
  const STORE = 't7eI.params.v1';
  const $ = id => document.getElementById(id);

  const els = {
    fileName: $('fileName'), fileInput: $('fileInput'), loadBtn: $('loadBtn'), sampleBtn: $('sampleBtn'),
    csvBtn: $('csvBtn'), xlsxBtn: $('xlsxBtn'), pngBtn: $('pngBtn'), bandMenu: $('bandMenu'),
    stage: document.querySelector('.stage'), img: $('imgCanvas'), ov: $('ovCanvas'), empty: $('emptyMsg'),
    rowsBar: $('rowsBar'), meta: $('imgMeta'),
    laneWidth: $('laneWidth'), laneWidthVal: $('laneWidthVal'), smoothing: $('smoothing'), smoothingVal: $('smoothingVal'),
    resetParams: $('resetParams'),
    chips: $('laneChips'), selTitle: $('selTitle'), prof: $('profCanvas'),
    resetBands: $('resetBands'), undoBands: $('undoBands'), removeLane: $('removeLane'), zoomBtn: $('zoomBtn'),
    editBands: $('editBands'), bandList: $('bandList'), laneType: $('laneType'),
    stParent: $('stParent'), stFc: $('stFc'), stEd: $('stEd'), selFlags: $('selFlags'),
    resBody: $('resBody'), resHint: $('resHint')
  };

  const state = {
    img: null, name: '', sig: null, sigPolarity: null,
    rows: [], result: null, sel: null, nextId: 1,
    params: loadParams(), drag: null, message: '', profZoom: false
  };

  // ------------------------------------------------------------ parameters

  function loadParams() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { saved = {}; }
    return sanitize(saved);
  }

  function sanitize(p) {
    const d = Object.assign({}, T.DEFAULTS);
    const choice = { polarity: ['dark', 'light'], background: ['valley', 'blend', 'envelope'], products: [1, 2] };
    for (const k of Object.keys(d)) {
      if (!(k in p)) continue;
      if (choice[k]) { if (choice[k].includes(p[k])) d[k] = p[k]; }
      else if (typeof p[k] === typeof d[k]) d[k] = p[k];
    }
    d.laneWidth = clamp(d.laneWidth, 0.2, 0.9);
    d.smoothing = clamp(d.smoothing, 0, 4);
    d.blendK = clamp(d.blendK, 0.02, 1);
    d.faintSNR = clamp(d.faintSNR, 1, 10);
    d.satFraction = clamp(d.satFraction, 0, 0.5);
    d.subtractNC = false;   // no lane roles in this interface, so no NC lanes to subtract
    d.formula = 'guschin';  // the lab's formula, not a user choice
    return d;
  }

  function saveParams() {
    try { localStorage.setItem(STORE, JSON.stringify(state.params)); } catch (e) { /* storage unavailable: settings last for this visit only */ }
  }

  // ------------------------------------------------------------ helpers

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function fmtInt(v) { return isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—'; }
  function fmtPct(v) { return isFinite(v) ? v.toFixed(1) : '—'; }
  function cssVar(n, f) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f; }
  function colors() {
    return {
      acc: cssVar('--color-accent', '#5980a6'), acc7: cssVar('--color-accent-700', '#416180'),
      acc3: cssVar('--color-accent-300', '#b5d9fd'), text: cssVar('--color-text', '#1d1f20'),
      bg: cssVar('--color-bg', '#f2f2f3'), warn: cssVar('--color-warn', '#a8552e')
    };
  }
  const isWarn = T.isWarning, SAME = T.SAME_BAND;   // the engine's warning list and band radius
  const MAX_PIXELS = 40e6;

  function signal() {
    if (!state.sig || state.sigPolarity !== state.params.polarity) {
      state.sig = T.signalImage(state.img, state.params.polarity);
      state.sigPolarity = state.params.polarity;
    }
    return state.sig;
  }

  function newLane(x) { return { id: state.nextId++, x: Math.round(x), role: null, label: '', valleys: null }; }

  function laneAt(ri, li) {
    const row = state.rows[ri];
    return row ? row.lanes[li] : null;
  }

  function resLane(ri, li) {
    const r = state.result && state.result.rows[ri];
    return r ? r.lanes[li] : null;
  }

  function selIndex() {
    if (!state.sel) return null;
    for (let ri = 0; ri < state.rows.length; ri++) {
      if (state.rows[ri].id !== state.sel.row) continue;
      const li = state.rows[ri].lanes.findIndex(l => l.id === state.sel.lane);
      if (li >= 0) return { ri, li };
    }
    return null;
  }

  function select(ri, li) {
    const row = state.rows[ri], lane = row && row.lanes[li];
    state.sel = lane ? { row: row.id, lane: lane.id } : null;
  }

  /** Display labels: markers are "M", every other lane is numbered across rows. */
  function labels() {
    const out = [];
    let n = 0;
    state.rows.forEach((row, ri) => {
      out.push(row.lanes.map((lane, li) => {
        const r = resLane(ri, li);
        const role = r ? r.role : lane.role;
        if (role !== 'marker') n++;
        return lane.label || (role === 'marker' ? 'M' : String(n));
      }));
    });
    return out;
  }

  function setMessage(text) {
    state.message = text || '';
    renderMeta();
  }

  // ------------------------------------------------------------ image loading

  let loadToken = 0;

  async function loadFile(file) {
    if (!file) return;
    const token = ++loadToken;   // a later load or the sample button wins over a slow decode
    setMessage('Reading ' + file.name + '…');
    try {
      const buf = await file.arrayBuffer();
      let img;
      if (TIFF.isTiff(buf)) {
        const t = await TIFF.decode(buf);
        img = T.makeImage(t.gray, t.w, t.h, t);
        img.saturationUnknown = !!t.saturationUnknown;
        img.storedBits = t.storedBits || t.bits;
      } else {
        const bmp = await createImageBitmap(new Blob([buf], { type: file.type || 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'from-image' });
        if (bmp.width * bmp.height > MAX_PIXELS) throw new Error('the image is ' + Math.round(bmp.width * bmp.height / 1e6) + ' megapixels; the limit is ' + MAX_PIXELS / 1e6 + ' MP. Crop it first.');
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(bmp, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        img = T.makeImage(T.rgbaToGray(d, c.width, c.height), c.width, c.height);
        if (/jpe?g$/i.test(file.name) || file.type === 'image/jpeg') img.lossy = true;
      }
      if (token !== loadToken) return;
      setImage(img, file.name, []);
      setMessage(state.rows.length ? '' : 'Drag a box over the bands of one row: parent band and both cleavage products. Repeat for each row.');
    } catch (err) {
      if (token !== loadToken) return;
      const why = err && err.name === 'InvalidStateError' ? 'the browser cannot decode this image format' : (err && err.message) || String(err);
      setMessage('Could not read ' + file.name + ': ' + why);
    }
  }

  function loadSample() {
    loadToken++;
    const s = SAMPLE.generate(7);
    setImage(T.makeImage(s.gray, s.w, s.h), s.name, s.rows);
    setMessage('Synthetic gel with known values. Lane 10 is overloaded on purpose (saturated parent) and lane 19 is underloaded.');
  }

  function setImage(img, name, regions) {
    state.img = img;
    state.name = name;
    state.drag = null;
    state.params.polarity = T.detectPolarity(img);
    state.sig = null;
    state.rows = [];
    state.sel = null;
    drawImage();
    regions.forEach(r => addRow(r, true));
    if (state.rows.length && state.rows[0].lanes.length) select(0, Math.min(1, state.rows[0].lanes.length - 1));
    recompute();
  }

  function drawImage() {
    const { img } = state;
    els.img.width = img.w; els.img.height = img.h;
    els.ov.width = img.w; els.ov.height = img.h;
    const ctx = els.img.getContext('2d');
    const id = ctx.createImageData(img.w, img.h);
    let lo = 0, hi = 255;
    if (img.bits > 8) {
      // Stretch only the display of high bit-depth images; measurement uses the raw values.
      const s = [];
      const step = Math.max(1, Math.floor(img.gray.length / 50000));
      for (let i = 0; i < img.gray.length; i += step) s.push(img.gray[i]);
      s.sort((a, b) => a - b);
      lo = s[Math.floor(s.length * 0.002)]; hi = s[Math.floor(s.length * 0.998)];
      if (hi <= lo) { lo = 0; hi = 255; }
    }
    const k = 255 / (hi - lo);
    state.disp = { lo, k };
    for (let i = 0, j = 0; i < img.gray.length; i++, j += 4) {
      const v = clamp((img.gray[i] - lo) * k, 0, 255);
      id.data[j] = id.data[j + 1] = id.data[j + 2] = v;
      id.data[j + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    els.empty.hidden = true;
    els.stage.classList.remove('is-empty');
  }

  // ------------------------------------------------------------ rows and lanes

  function addRow(rect, quiet) {
    const r = {
      x0: Math.round(Math.max(0, Math.min(rect.x0, rect.x1))), x1: Math.round(Math.min(state.img.w, Math.max(rect.x0, rect.x1))),
      y0: Math.round(Math.max(0, Math.min(rect.y0, rect.y1))), y1: Math.round(Math.min(state.img.h, Math.max(rect.y0, rect.y1)))
    };
    // A new box that mostly covers an existing row replaces it.
    const area = q => Math.max(0, q.x1 - q.x0) * Math.max(0, q.y1 - q.y0);
    const overlap = (a, b) => area({ x0: Math.max(a.x0, b.x0), x1: Math.min(a.x1, b.x1), y0: Math.max(a.y0, b.y0), y1: Math.min(a.y1, b.y1) });
    const keep = state.rows.filter(q => overlap(q, r) < 0.5 * Math.min(area(q), area(r)));
    const replaced = state.rows.length - keep.length;
    const d = T.detectLanes(signal(), state.img, r);
    const row = Object.assign({ id: state.nextId++, pitch: d.pitch }, r, { lanes: d.xs.map(newLane) });
    keep.push(row);
    keep.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    state.rows = keep;
    if (!quiet) {
      setMessage(row.lanes.length
        ? (replaced ? 'Row redrawn: ' : 'Row added: ') + row.lanes.length + ' lanes found, lane pitch ' + Math.round(d.pitch) + ' px.'
        : 'No lanes found in that box. Check the band polarity or draw the box over the bands.');
      const ri = state.rows.indexOf(row);
      if (row.lanes.length) select(ri, 0);
    }
    return row;
  }

  /** Find the lanes of a row again; a new lane close to an old one keeps its role and label. */
  function redetectRow(row, keepBoundaries) {
    const d = T.detectLanes(signal(), state.img, row);
    const old = row.lanes, used = new Set();
    row.pitch = d.pitch;
    row.lanes = d.xs.map(x => {
      const lane = newLane(x);
      const near = old.filter(l => !used.has(l) && Math.abs(l.x - x) < d.pitch / 2).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
      if (near) { used.add(near); lane.role = near.role; lane.label = near.label; if (keepBoundaries) lane.valleys = near.valleys; }
      return lane;
    });
  }

  /** Clear every lane's hand-made band choices, boundaries and undo history, and say so if there were any. */
  function resetEdits(message) {
    const edited = state.rows.some(row => row.lanes.some(l => l.bands || l.valleys));
    state.rows.forEach(row => row.lanes.forEach(l => { l.valleys = null; l.bands = null; l.undo = []; }));
    closeBandMenu();
    if (edited) setMessage(message);
  }

  /** Find the lanes of every row again (new polarity); hand-made band choices do not carry over. */
  function redetectAll() {
    const edited = state.rows.some(row => row.lanes.some(l => l.bands || l.valleys));
    state.rows.forEach(row => redetectRow(row, false));
    if (edited) setMessage('Lanes found again for the new polarity; band choices made by hand were cleared.');
  }

  function redetect(ri) {
    redetectRow(state.rows[ri], false);
    if (state.rows[ri].lanes.length) select(ri, 0);
    recompute();
  }

  function removeRow(ri) {
    state.rows.splice(ri, 1);
    if (!selIndex()) state.sel = null;
    recompute();
  }

  function removeSelectedLane() {
    const s = selIndex();
    if (!s) return;
    state.drag = null;
    const row = state.rows[s.ri];
    row.lanes.splice(s.li, 1);
    if (row.lanes.length) select(s.ri, Math.min(s.li, row.lanes.length - 1));
    else state.sel = null;
    recompute();
  }

  function recompute() {
    if (els.bandMenu) els.bandMenu.hidden = true;   // its band and lane may no longer exist
    if (!state.img) { state.result = null; render(); return; }
    state.rows.forEach(row => row.lanes.sort((a, b) => a.x - b.x));
    state.result = state.rows.length ? T.analyze(state.img, state.rows, state.params, signal()) : null;
    if (!selIndex() && state.rows.length && state.rows[0].lanes.length) select(0, 0);
    render();
  }

  let frame = 0;
  function recomputeSoon() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; recompute(); });
  }

  // ------------------------------------------------------------ rendering

  function render() {
    renderParams();
    renderOverlay();
    renderRowsBar();
    renderChips();
    renderLane();
    renderTable();
    renderMeta();
    const has = !!state.result;
    els.csvBtn.disabled = els.xlsxBtn.disabled = els.pngBtn.disabled = !has;
  }

  function renderParams() {
    const p = state.params;
    document.querySelectorAll('.controls .seg[data-param]').forEach(seg => {
      const key = seg.dataset.param;
      seg.querySelectorAll('input').forEach(inp => { inp.checked = String(p[key]) === inp.value; });
    });
    els.laneWidth.value = Math.round(p.laneWidth * 100);
    els.laneWidthVal.textContent = Math.round(p.laneWidth * 100);
    els.smoothing.value = p.smoothing;
    els.smoothingVal.textContent = p.smoothing.toFixed(1);
  }

  function renderMeta() {
    const img = state.img;
    const parts = [];
    if (img) {
      parts.push(img.w + ' × ' + img.h + ' px, ' + img.bits + '-bit' + (img.storedBits > img.bits ? ' data in a ' + img.storedBits + '-bit file' : '') +
        (img.lossy ? ' JPEG (lossy: prefer a raw TIFF for quantification)' : '') +
        (img.saturationUnknown ? ' (floating point: saturation cannot be checked)' : ''));
    }
    els.meta.textContent = parts.join(' · ');
    if (state.message) {
      const m = document.createElement('div');
      m.className = 'note';
      m.textContent = state.message;
      els.meta.appendChild(m);
    }
    els.fileName.textContent = state.name || 'no image';
    els.fileName.title = state.name || '';
  }

  function renderOverlay() {
    const c = els.ov;
    if (!state.img) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    // Overlay strokes and text keep a constant on-screen size whatever the image resolution.
    const col = colors(), u = Math.max(0.5, state.img.w / Math.max(1, els.ov.clientWidth || state.img.w)) * 0.85;
    const sel = selIndex(), labs = labels();
    ctx.font = `600 ${13 * u}px "Barlow Condensed", sans-serif`;
    ctx.textAlign = 'center';
    state.rows.forEach((row, ri) => {
      const rr = state.result && state.result.rows[ri];
      ctx.strokeStyle = col.acc; ctx.lineWidth = u; ctx.setLineDash([6 * u, 4 * u]);
      ctx.strokeRect(row.x0 + 0.5, row.y0 + 0.5, row.x1 - row.x0, row.y1 - row.y0);
      ctx.setLineDash([]);
      if (!rr) return;
      rr.lanes.forEach((l, li) => {
        const isSel = sel && sel.ri === ri && sel.li === li;
        const dim = l.role === 'marker' || l.role === 'excluded';
        ctx.globalAlpha = dim ? 0.45 : 1;
        if (isSel) { ctx.fillStyle = col.acc; ctx.globalAlpha = 0.18; ctx.fillRect(l.a, row.y0, l.b - l.a + 1, row.y1 - row.y0); ctx.globalAlpha = dim ? 0.45 : 1; }
        ctx.strokeStyle = col.acc; ctx.lineWidth = isSel ? 2 * u : u;
        if (l.role === 'excluded') ctx.setLineDash([3 * u, 3 * u]);
        ctx.strokeRect(l.a + 0.5, row.y0 + 0.5, l.b - l.a, row.y1 - row.y0);
        ctx.setLineDash([]);
        if (l.role !== 'excluded' && l.role !== 'marker') {
          l.peaks.forEach((p, k) => {
            const y = row.y0 + p + 0.5;
            ctx.strokeStyle = k === 0 ? (l.flags.includes('parent saturated') ? col.warn : col.acc7) : col.acc;
            ctx.lineWidth = 2 * u;
            if (!l.found[k]) ctx.setLineDash([2 * u, 2 * u]);
            ctx.beginPath(); ctx.moveTo(l.a - 3 * u, y); ctx.lineTo(l.b + 3 * u, y); ctx.stroke();
            ctx.setLineDash([]);
          });
        }
        const cx = (l.a + l.b) / 2;
        ctx.fillStyle = col.acc7;
        ctx.textBaseline = 'bottom';
        ctx.fillText(labs[ri][li], cx, row.y0 - 4 * u);
        ctx.textBaseline = 'top';
        const txt = l.role === 'marker' ? '' : l.role === 'excluded' ? '×' : fmtPct(l.editing);
        ctx.fillStyle = l.flags.some(isWarn) && l.role !== 'excluded' ? col.warn : col.text;
        ctx.fillText(txt, cx, row.y1 + 4 * u);
        ctx.globalAlpha = 1;
      });
    });
    const d = state.drag;
    if (d && d.kind === 'region' && d.moved) {
      ctx.strokeStyle = col.acc7; ctx.lineWidth = 1.5 * u; ctx.setLineDash([4 * u, 3 * u]);
      ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.setLineDash([]);
    }
  }

  function renderRowsBar() {
    els.rowsBar.textContent = '';
    state.rows.forEach((row, ri) => {
      const chip = document.createElement('span');
      chip.className = 'row-chip';
      const t = document.createElement('span');
      t.textContent = 'Row ' + (ri + 1) + ' · ' + row.lanes.length + ' lanes';
      const re = button('Detect lanes', () => redetect(ri), 'Find the lanes in this row again. Moved or added lanes, band choices and band boundaries are reset; labels are kept.');
      const rm = button('Remove', () => removeRow(ri), 'Remove this row');
      chip.append(t, re, rm);
      els.rowsBar.appendChild(chip);
    });
  }

  function button(text, fn, title) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn btn-ghost'; b.textContent = text;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    return b;
  }

  function renderChips() {
    els.chips.textContent = '';
    const sel = selIndex(), labs = labels();
    state.rows.forEach((row, ri) => {
      if (ri > 0) { const s = document.createElement('span'); s.className = 'chip-sep'; els.chips.appendChild(s); }
      row.lanes.forEach((lane, li) => {
        const r = resLane(ri, li);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-secondary chip';
        if (sel && sel.ri === ri && sel.li === li) b.classList.add('on');
        if (r && (r.role === 'marker' || r.role === 'excluded')) b.classList.add('dim');
        if (r && r.role !== 'excluded' && r.flags.some(isWarn)) b.classList.add('warn');
        b.textContent = labs[ri][li];
        b.title = 'Row ' + (ri + 1) + ', lane ' + labs[ri][li];
        b.addEventListener('click', () => { select(ri, li); render(); });
        els.chips.appendChild(b);
      });
    });
  }

  function renderLane() {
    const s = selIndex();
    const menuLane = s ? laneAt(s.ri, s.li).id : null;
    if (menuLane !== state.menuLane) { state.menuLane = menuLane; if (els.bandMenu) els.bandMenu.hidden = true; }
    const r = s && resLane(s.ri, s.li), lane = s && laneAt(s.ri, s.li);
    const labs = labels();
    els.selTitle.textContent = s ? 'Row ' + (s.ri + 1) + ' · Lane ' + labs[s.ri][s.li] : '—';
    els.resetBands.disabled = !lane || (!lane.valleys && !lane.bands);
    els.undoBands.disabled = !lane || !(lane.undo && lane.undo.length);
    els.editBands.disabled = !r || r.role === 'marker' || r.role === 'excluded';
    els.laneType.hidden = !r || !(r.role === 'marker' || (lane && lane.role === 'sample'));
    els.laneType.textContent = r && r.role === 'marker' ? 'Measure this lane' : 'Automatic lane type';
    if (els.bandList) renderBandList(s, r);
    els.removeLane.disabled = !lane;
    const quant = r && r.role !== 'marker' && r.role !== 'excluded';
    els.stParent.textContent = quant ? fmtInt(r.areas[0]) : '—';
    els.stFc.textContent = quant ? r.fc.toFixed(3) : '—';
    els.stEd.textContent = quant ? fmtPct(r.editing) + (r.flags.includes('parent saturated') ? ' ⚠' : '') : '—';
    els.selFlags.textContent = '';
    if (r) {
      const flags = r.flags.slice();
      if (r.role === 'marker') flags.unshift('marker lane: not quantified');
      if (r.flags.includes('product saturated')) flags.push('clipped bands: % editing is unreliable');
      else if (r.flags.includes('parent saturated')) flags.push('clipped parent reads high: % editing is an upper bound');
      flags.forEach(f => {
        const t = document.createElement('span');
        t.className = 'flag' + (isWarn(f) || /upper bound|unreliable/.test(f) ? ' warn' : '');
        t.textContent = f;
        els.selFlags.appendChild(t);
      });
    }
    drawProfile(r);
  }

  const STRIP = 14;   // height of the lane image strip drawn above the plot
  const PAD = { l: 40, r: 10, t: 16 + STRIP + 6, b: 22 };

  function profScale(r) {
    const c = els.prof, w = c.clientWidth, h = c.clientHeight;
    const n = r.profile.length;
    let lo = Infinity, hi = -Infinity;
    for (const v of r.profile) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (state.profZoom && r.valleys && r.valleys.length > 2) {
      // Scale to the cleavage products; the parent peak runs off the top of the plot.
      hi = -Infinity;
      const s0 = r.segKinds ? Math.max(0, r.segKinds.indexOf(0)) : 0;
      for (let i = r.valleys[s0 + 1]; i < n; i++) hi = Math.max(hi, r.profile[i]);
      hi += (hi - lo) * 0.25;
    }
    lo = Math.floor(lo - 2); hi = Math.ceil(hi + (hi - lo) * 0.08 + 2);
    const pw = w - PAD.l - PAD.r, ph = h - PAD.t - PAD.b;
    return {
      w, h, n, lo, hi,
      X: i => PAD.l + (n > 1 ? i / (n - 1) : 0) * pw,
      Y: v => PAD.t + ph - (v - lo) / (hi - lo) * ph,
      I: x => clamp(Math.round((x - PAD.l) / pw * (n - 1)), 0, n - 1)
    };
  }

  function drawProfile(r) {
    const c = els.prof, dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, c.clientWidth * dpr); c.height = Math.max(1, c.clientHeight * dpr);
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, c.clientWidth, c.clientHeight);
    const col = colors();
    if (!r) {
      x.fillStyle = col.text; x.globalAlpha = 0.5; x.font = '13px Barlow, sans-serif'; x.textAlign = 'center';
      x.fillText(state.img ? 'Draw a row on the image, then pick a lane.' : 'Load an image to begin.', c.clientWidth / 2, c.clientHeight / 2);
      x.globalAlpha = 1;
      return;
    }
    const S = profScale(r), p = r.profile, b = r.baseline;
    // the lane itself as an image strip, aligned with the profile's distance axis
    if (state.img && state.disp) {
      const img = state.img, d = state.disp;
      for (let i = 0; i < S.n; i++) {
        const y = r.y0 + i;
        if (y < 0 || y >= img.h) continue;
        let sum = 0;
        for (let xx = r.a; xx <= r.b; xx++) sum += img.gray[y * img.w + xx];
        const v = Math.round(clamp((sum / (r.b - r.a + 1) - d.lo) * d.k, 0, 255));
        x.fillStyle = `rgb(${v},${v},${v})`;
        const x0 = S.X(i - 0.5), x1 = S.X(i + 0.5);
        x.fillRect(Math.floor(x0), 6, Math.ceil(x1 - x0) + 1, STRIP);
      }
      x.strokeStyle = col.text; x.globalAlpha = 0.25; x.lineWidth = 1;
      x.strokeRect(PAD.l + 0.5, 6.5, S.w - PAD.l - PAD.r - 1, STRIP - 1);
      x.globalAlpha = 0.6; x.fillStyle = col.text; x.font = '10px Barlow, sans-serif'; x.textAlign = 'right'; x.textBaseline = 'middle';
      x.fillText('lane', PAD.l - 6, 6 + STRIP / 2);
      x.globalAlpha = 1;
    }
    // grid and axes
    x.font = '10px Barlow, sans-serif'; x.fillStyle = col.text; x.strokeStyle = col.text;
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const v = S.lo + (S.hi - S.lo) * t / ticks, y = Math.round(S.Y(v)) + 0.5;
      x.globalAlpha = 0.12; x.beginPath(); x.moveTo(PAD.l, y); x.lineTo(S.w - PAD.r, y); x.stroke();
      x.globalAlpha = 0.55; x.textAlign = 'right'; x.textBaseline = 'middle'; x.fillText(Math.round(v), PAD.l - 6, y);
    }
    x.textAlign = 'center'; x.textBaseline = 'top';
    for (let t = 0; t <= ticks; t++) { const i = Math.round((S.n - 1) * t / ticks); x.fillText(i, S.X(i), S.h - PAD.b + 6); }
    x.globalAlpha = 1;
    // band areas, clipped to the plot so a zoomed-out parent stays inside the frame
    x.save();
    x.beginPath(); x.rect(PAD.l, PAD.t, S.w - PAD.l - PAD.r, S.h - PAD.t - PAD.b); x.clip();
    const quant = r.role !== 'marker' && r.role !== 'excluded';
    if (quant) {
      const pc = r.corrected || p;   // areas are measured on the profile with removed bands taken out
      for (let s = 0; s < r.valleys.length - 1; s++) {
        const kind = r.segKinds ? r.segKinds[s] : s;
        if (kind > 0 && !r.found[kind] && r.areas[kind] === 0) continue;
        const top = kind < 0 ? p : pc;
        x.globalAlpha = kind < 0 ? 0.1 : kind === 0 ? 0.32 : 0.2;
        x.fillStyle = kind < 0 ? col.text : kind === 0 && r.flags.includes('parent saturated') ? col.warn : col.acc;
        x.beginPath();
        for (let i = r.valleys[s]; i <= r.valleys[s + 1]; i++) x.lineTo(S.X(i), S.Y(Math.max(top[i], b[i])));
        for (let i = r.valleys[s + 1]; i >= r.valleys[s]; i--) x.lineTo(S.X(i), S.Y(b[i]));
        x.closePath(); x.fill();
      }
      if (r.corrected) {
        x.strokeStyle = col.text; x.globalAlpha = 0.5; x.lineWidth = 1; x.setLineDash([2, 3]); x.beginPath();
        for (let i = r.valleys[0]; i <= r.valleys[r.valleys.length - 1]; i++) x.lineTo(S.X(i), S.Y(pc[i]));
        x.stroke(); x.setLineDash([]); x.globalAlpha = 1;
      }
      x.globalAlpha = 1;
      x.strokeStyle = col.acc7; x.lineWidth = 1.25; x.setLineDash([5, 4]); x.beginPath();
      for (let i = r.valleys[0]; i <= r.valleys[r.valleys.length - 1]; i++) x.lineTo(S.X(i), S.Y(b[i]));
      x.stroke(); x.setLineDash([]);
    }
    // profile
    x.strokeStyle = col.text; x.lineWidth = 1.5; x.beginPath();
    for (let i = 0; i < S.n; i++) x.lineTo(S.X(i), S.Y(p[i]));
    x.stroke();
    x.restore();
    if (!quant) return;
    // band labels and boundary handles
    x.font = '600 12px "Barlow Condensed", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'bottom';
    const labelY = i => Math.max(PAD.t + 12, S.Y(p[i]) - 3);
    // Other detected peaks: grey dots, clickable to assign or remove.
    (r.candidates || []).forEach(i => {
      if (r.peaks.some(pk => Math.abs(pk - i) <= SAME) || (r.removed || []).some(j => Math.abs(j - i) <= SAME)) return;
      x.fillStyle = col.text; x.globalAlpha = 0.45;
      x.beginPath(); x.arc(S.X(i), labelY(i) - 4, 2.5, 0, 2 * Math.PI); x.fill();
    });
    (r.removed || []).forEach(i => { x.fillStyle = col.text; x.globalAlpha = 0.6; x.fillText('✕', S.X(i), labelY(i)); });
    r.peaks.forEach((pk, k) => {
      x.fillStyle = k === 0 ? col.acc7 : col.acc;
      x.globalAlpha = r.found[k] ? 1 : 0.45;
      x.fillText((k === 0 ? 'P' : String(k)) + (r.fixed && r.fixed[k] ? '•' : ''), S.X(pk), labelY(pk));
    });
    x.globalAlpha = 1;
    r.valleys.forEach((v, k) => {
      const hx = Math.round(S.X(v)) + 0.5;
      const active = state.drag && state.drag.kind === 'valley' && state.drag.k === k;
      x.strokeStyle = col.acc7; x.globalAlpha = active ? 0.9 : 0.4; x.lineWidth = 1;
      x.beginPath(); x.moveTo(hx, PAD.t); x.lineTo(hx, S.h - PAD.b); x.stroke();
      x.globalAlpha = 1; x.fillStyle = active ? col.acc7 : col.bg; x.strokeStyle = col.acc7;
      x.fillRect(hx - 4, S.h - PAD.b - 9, 8, 8); x.strokeRect(hx - 4, S.h - PAD.b - 9, 8, 8);
    });
  }

  function renderTable() {
    const body = els.resBody;
    body.textContent = '';
    const sel = selIndex(), labs = labels();
    let maxEd = 1;
    if (state.result) state.result.rows.forEach(rr => rr.lanes.forEach(l => { if (isFinite(l.editing)) maxEd = Math.max(maxEd, l.editing); }));
    let count = 0;
    state.rows.forEach((row, ri) => row.lanes.forEach((lane, li) => {
      const r = resLane(ri, li);
      if (!r) return;
      count++;
      const tr = document.createElement('tr');
      const quant = r.role !== 'marker' && r.role !== 'excluded';
      if (sel && sel.ri === ri && sel.li === li) tr.className = 'sel';
      if (!quant) tr.classList.add('dim');
      tr.tabIndex = 0;
      tr.addEventListener('click', e => { if (e.target.closest('input,select')) return; select(ri, li); render(); });
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === tr) { select(ri, li); render(); } });

      const td = (content, cls) => { const d = document.createElement('td'); if (cls) d.className = cls; if (content instanceof Node) d.appendChild(content); else d.textContent = content; tr.appendChild(d); return d; };
      td((ri + 1) + '·' + (li + 1), 'lane-n');
      const inp = document.createElement('input');
      inp.className = 'label-in'; inp.value = lane.label; inp.placeholder = labs[ri][li];
      inp.setAttribute('aria-label', 'Lane label');
      inp.addEventListener('change', () => { lane.label = inp.value.trim(); render(); });
      td(inp);
      td(quant ? fmtInt(r.areas[0]) : '—', 'num');
      td(quant ? fmtInt(r.areas[1]) : '—', 'num');
      td(quant && r.areas.length > 2 ? fmtInt(r.areas[2]) : '—', 'num');
      td(quant ? r.fc.toFixed(3) : '—', 'num');
      const ed = td(quant ? fmtPct(r.editing) : '—', 'num ed-val');
      if (r.flags.includes('parent saturated')) ed.classList.add('sat');
      const bar = document.createElement('div'); bar.className = 'bar';
      const fill = document.createElement('div');
      fill.style.width = (quant && isFinite(r.editing) ? clamp(r.editing / maxEd * 100, 0, 100) : 0).toFixed(1) + '%';
      bar.appendChild(fill);
      td(bar);
      const q = td('', 'qc');
      if (quant) r.flags.forEach((f, i) => {
        const s = document.createElement('span');
        s.className = isWarn(f) ? 'qc-warn' : 'qc-info';
        s.textContent = (i ? ', ' : '') + shortFlag(f);
        q.appendChild(s);
      });
      q.title = r.flags.join('; ');
      body.appendChild(tr);
    }));
    const p = state.params;
    els.resHint.textContent = count
      ? 'Guschin formula · ' + { valley: 'valley', blend: 'blend', envelope: 'envelope' }[p.background] + ' baseline'
      : '';
  }

  function shortFlag(f) {
    return ({ 'parent saturated': 'saturated', 'product saturated': 'product saturated', 'weak lane': 'weak', 'band cut by the box edge': 'edge',
      'band at the top of the box: a well?': 'well?', 'unassigned band inside the measured range': 'unassigned band', 'band above the parent': 'band above', 'one product and few lanes: bands not cross-checked': 'few lanes', 'parent lower than in nearby lanes': 'parent lower',
      'extra band not matching the cleavage products': 'extra band', 'check band assignment': 'check bands', 'no cleavage products found': 'no products',
      'manual band boundaries': 'edited', 'only one cleavage product found': 'one product', 'second product visible: set two products': 'second product?',
      'cleavage product brighter than parent': 'brighter product', 'manual band assignment': 'bands set',
      'removed band overlaps a measured band': 'overlap', 'product positions differ from the row': 'other pattern',
      'bands overlap: result depends on the baseline': 'bands overlap', 'band boundary crosses a band': 'boundary crosses band',
      'parent at a product position of the row': 'parent at product', 'result depends on the smoothing': 'smoothing', 'manual band boundaries ignored: the number of bands changed': 'edits dropped' })[f] ||
      f.replace('product ', 'P').replace(' not detected', ' missing').replace(/fraction cleaved > 0.5.*/, 'f > 0.5');
  }

  // ------------------------------------------------------------ pointer input

  function imgPoint(e) {
    const rect = els.ov.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / rect.width * state.img.w, 0, state.img.w),
      y: clamp((e.clientY - rect.top) / rect.height * state.img.h, 0, state.img.h)
    };
  }

  function hitLane(pt) {
    if (!state.result) return null;
    const tol = Math.max(2, state.img.w / 400);
    for (let ri = 0; ri < state.rows.length; ri++) {
      const row = state.rows[ri], rr = state.result.rows[ri];
      if (pt.y < row.y0 - tol || pt.y > row.y1 + tol) continue;
      for (let li = 0; li < rr.lanes.length; li++) {
        const l = rr.lanes[li];
        if (pt.x >= l.a - tol && pt.x <= l.b + tol) return { ri, li };
      }
    }
    return null;
  }

  function hitRow(pt) {
    return state.rows.findIndex(r => pt.x >= r.x0 && pt.x <= r.x1 && pt.y >= r.y0 && pt.y <= r.y1);
  }

  els.ov.addEventListener('pointerdown', e => {
    if (!state.img || e.button !== 0) return;
    e.preventDefault();
    els.ov.focus();
    els.ov.setPointerCapture(e.pointerId);
    const pt = imgPoint(e), hit = hitLane(pt);
    if (hit) {
      select(hit.ri, hit.li);
      state.drag = { kind: 'lane', ri: hit.ri, id: laneAt(hit.ri, hit.li).id, sx: pt.x, x0: laneAt(hit.ri, hit.li).x, moved: false };
      render();
    } else {
      state.drag = { kind: 'region', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, moved: false };
    }
  });

  els.ov.addEventListener('pointermove', e => {
    const d = state.drag;
    if (!d || !state.img) return;
    const pt = imgPoint(e);
    if (d.kind === 'lane') {
      const dx = pt.x - d.sx;
      if (!d.moved && Math.abs(dx) < 2) return;
      d.moved = true;
      const lane = state.rows[d.ri] && state.rows[d.ri].lanes.find(l => l.id === d.id);
      if (!lane) { state.drag = null; return; }
      lane.x = Math.round(clamp(d.x0 + dx, state.rows[d.ri].x0, state.rows[d.ri].x1));
      recomputeSoon();
    } else if (d.kind === 'region') {
      d.x1 = pt.x; d.y1 = pt.y;
      if (Math.abs(d.x1 - d.x0) + Math.abs(d.y1 - d.y0) > 6) d.moved = true;
      renderOverlay();
    }
  });

  function endDrag() {
    const d = state.drag;
    state.drag = null;
    if (!d) return;
    if (d.kind === 'region' && d.moved && Math.abs(d.x1 - d.x0) > 15 && Math.abs(d.y1 - d.y0) > 10) {
      addRow(d);
      recompute();
    } else if (d.kind === 'region' && !d.moved) {
      state.sel = null;   // a click on empty gel clears the selection, so Delete cannot hit a stale lane
      render();
    } else {
      renderOverlay();
    }
  }
  els.ov.addEventListener('pointerup', endDrag);
  els.ov.addEventListener('pointercancel', endDrag);

  els.ov.addEventListener('dblclick', e => {
    if (!state.img) return;
    const pt = imgPoint(e);
    if (hitLane(pt)) return;
    const ri = hitRow(pt);
    if (ri < 0) return;
    const lane = newLane(pt.x);
    state.rows[ri].lanes.push(lane);
    state.sel = { row: state.rows[ri].id, lane: lane.id };
    recompute();
  });

  document.addEventListener('keydown', e => {
    // Lane shortcuts apply only when the gel, the profile or a results row has focus (or nothing does).
    const t = e.target;
    const scope = t === document.body || t === els.ov || t === els.prof || (t.closest && t.closest('#resBody tr') === t);
    if (!scope) return;
    const s = selIndex();
    if (!s) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelectedLane(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const lane = laneAt(s.ri, s.li), row = state.rows[s.ri];
      lane.x = clamp(lane.x + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1), row.x0, row.x1);
      recompute();
    } else if (e.key === '[' || e.key === ']') {
      const flat = [];
      state.rows.forEach((row, ri) => row.lanes.forEach((l, li) => flat.push([ri, li])));
      const i = flat.findIndex(([ri, li]) => ri === s.ri && li === s.li);
      const j = clamp(i + (e.key === '[' ? -1 : 1), 0, flat.length - 1);
      select(flat[j][0], flat[j][1]);
      render();
    }
  });

  // Band boundaries: drag the square handles on the profile.
  els.prof.addEventListener('pointerdown', e => {
    const s = selIndex(), r = s && resLane(s.ri, s.li);
    if (!r || r.role === 'marker' || r.role === 'excluded') return;
    const rect = els.prof.getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const S = profScale(r);
    let best = -1, bd = 9;
    r.valleys.forEach((v, k) => { const d = Math.abs(S.X(v) - mx); if (d < bd) { bd = d; best = k; } });
    const peak = peakAt(r, S, mx, e.pointerType === 'touch' ? 22 : 10);
    // Near a boundary marker (or in the handle strip at the bottom) drag it; otherwise a peak opens its menu.
    if (peak != null && (best < 0 || (my < S.h - PAD.b - 14 && Math.abs(S.X(peak) - mx) < bd))) {
      e.preventDefault();
      openBandMenu(s, r, S, peak);
      return;
    }
    closeBandMenu();
    if (best < 0) return;
    e.preventDefault();
    els.prof.setPointerCapture(e.pointerId);
    // The boundaries become manual only once a handle actually moves.
    state.drag = { kind: 'valley', k: best, rowId: state.rows[s.ri].id, laneId: laneAt(s.ri, s.li).id, start: r.valleys.map(v => v + r.y0) };
    recompute();
  });

  els.prof.addEventListener('pointermove', e => {
    const d = state.drag;
    const s = selIndex(), r = s && resLane(s.ri, s.li);
    if (!r) return;
    const rect = els.prof.getBoundingClientRect(), mx = e.clientX - rect.left;
    const S = profScale(r);
    if (!d || d.kind !== 'valley') {
      const near = r.role !== 'marker' && r.role !== 'excluded' && r.valleys.some(v => Math.abs(S.X(v) - mx) < 9);
      els.prof.style.cursor = near ? 'ew-resize' : 'default';
      return;
    }
    // Resolve the dragged lane by id: keyboard moves can reorder lanes during the drag.
    const ri = state.rows.findIndex(row => row.id === d.rowId);
    const li = ri < 0 ? -1 : state.rows[ri].lanes.findIndex(l => l.id === d.laneId);
    if (li < 0 || ri !== s.ri || li !== s.li) { state.drag = null; return; }
    // Drag what is on screen: stored boundaries that no longer fit the bands are not in use.
    const lane = laneAt(ri, li);
    const own = lane.valleys && lane.valleys.length === d.start.length ? lane.valleys : d.start;
    const v = own.map(y => y - r.y0);
    const lo = d.k === 0 ? 0 : v[d.k - 1] + 1, hi = d.k === v.length - 1 ? S.n - 1 : v[d.k + 1] - 1;
    const to = clamp(S.I(mx), lo, hi);
    if (own === d.start && to === v[d.k]) return;   // pointer jitter on the handle is not an edit
    if (!d.saved) { saveUndo(lane); d.saved = true; }
    v[d.k] = to;
    lane.valleys = v.map(i => i + r.y0);
    recomputeSoon();
  });

  function endValley() { if (state.drag && state.drag.kind === 'valley') { state.drag = null; recompute(); } }
  els.prof.addEventListener('pointerup', endValley);
  els.prof.addEventListener('pointercancel', endValley);

  // ------------------------------------------------------------ controls

  document.querySelectorAll('.controls .seg[data-param]').forEach(seg => {
    const key = seg.dataset.param;
    seg.addEventListener('change', e => {
      const v = e.target.value;
      state.params[key] = key === 'products' ? Number(v) : v;
      saveParams();
      if (key === 'polarity' && state.img) redetectAll();
      // Manual boundaries are tied to the number of bands, so a new product count resets them.
      // Band choices and boundaries depend on the number of bands: a new product count starts them afresh.
      if (key === 'products') resetEdits('Product count changed; band choices and boundaries set by hand were cleared.');
      recompute();
    });
  });

  els.laneWidth.addEventListener('input', () => { state.params.laneWidth = Number(els.laneWidth.value) / 100; saveParams(); recomputeSoon(); });
  els.smoothing.addEventListener('input', () => { state.params.smoothing = Number(els.smoothing.value); saveParams(); recomputeSoon(); });
  els.resetParams.addEventListener('click', () => {
    const oldPol = state.params.polarity, oldProducts = state.params.products;
    state.params = Object.assign({}, T.DEFAULTS, { polarity: state.img ? T.detectPolarity(state.img) : oldPol });
    if (state.img && state.params.polarity !== oldPol) redetectAll();
    if (state.params.products !== oldProducts) resetEdits('Product count changed; band choices and boundaries set by hand were cleared.');
    saveParams();
    recompute();
  });

  els.resetBands.addEventListener('click', () => {
    const s = selIndex();
    if (s) { const lane = laneAt(s.ri, s.li); saveUndo(lane); lane.valleys = null; lane.bands = null; closeBandMenu(); recompute(); }
  });
  els.undoBands.addEventListener('click', () => {
    const s = selIndex();
    if (!s) return;
    const lane = laneAt(s.ri, s.li);
    if (!lane.undo || !lane.undo.length) return;
    const prev = JSON.parse(lane.undo.pop());
    lane.bands = prev.bands; lane.valleys = prev.valleys;
    closeBandMenu();
    recompute();
  });

  // ------------------------------------------------------------ band menu (remove or assign a peak)

  /** Nearest clickable peak (assigned, removed or detected) within `radius` px of the pointer. */
  function peakAt(r, S, mx, radius) {
    const all = r.peaks.concat(r.removed || [], r.candidates || []);
    let best = null, bd = radius || 10;
    all.forEach(i => { const d = Math.abs(S.X(i) - mx); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  function bandRole(r, i) {
    if ((r.removed || []).some(j => Math.abs(j - i) <= SAME)) return 'removed';
    const k = r.peaks.findIndex((pk, m) => Math.abs(pk - i) <= SAME && (m === 0 || !r.found || r.found[m]));
    if (k === 0) return 'parent';
    if (k > 0) return 'p' + k;
    return 'none';
  }

  /** Remember a lane's band choices and boundaries so the next edit can be undone. */
  function saveUndo(lane) {
    lane.undo = (lane.undo || []).slice(-19);
    lane.undo.push(JSON.stringify({ bands: lane.bands || null, valleys: lane.valleys || null }));
  }

  function setBand(lane, absY, role) {
    saveUndo(lane);
    const b = lane.bands ? JSON.parse(JSON.stringify(lane.bands)) : { parent: null, products: [null, null], removed: [] };
    const same = v => v != null && Math.abs(v - absY) <= SAME;
    if (same(b.parent)) b.parent = null;
    b.products = b.products.map(v => (same(v) ? null : v));
    b.removed = b.removed.filter(v => !same(v));
    if (role === 'parent') b.parent = absY;
    else if (role === 'p1') b.products[0] = absY;
    else if (role === 'p2') b.products[1] = absY;
    else if (role === 'removed') b.removed.push(absY);
    lane.bands = b.parent == null && !b.products.some(v => v != null) && !b.removed.length ? null : b;
    lane.valleys = null;   // band set changed: boundaries are found again
  }

  function openBandMenu(s, r, S, i) {
    const lane = laneAt(s.ri, s.li), role = bandRole(r, i), absY = i + r.y0;
    const b = lane.bands || {};
    const manual = [b.parent].concat(b.products || [], b.removed || []).some(v => v != null && Math.abs(v - absY) <= SAME);
    const m = els.bandMenu;
    m.textContent = '';
    const title = document.createElement('div');
    title.className = 'menu-title';
    const roleText = { parent: ' · parent', p1: ' · product 1', p2: ' · product 2', removed: ' · removed' }[role] || '';
    title.textContent = 'Band at ' + i + ' px' + roleText;
    m.appendChild(title);
    const add = (text, fn) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-ghost'; btn.setAttribute('role', 'menuitem'); btn.textContent = text;
      btn.addEventListener('click', ev => { ev.stopPropagation(); fn(); closeBandMenu(); recompute(); els.prof.focus(); });
      m.appendChild(btn);
    };
    if (role !== 'removed') add('Remove this band', () => setBand(lane, absY, 'removed'));
    if (role === 'removed') add('Restore', () => setBand(lane, absY, 'auto'));
    if (role !== 'parent') add('Use as parent', () => setBand(lane, absY, 'parent'));
    if (role !== 'p1') add('Use as product 1', () => setBand(lane, absY, 'p1'));
    if (state.params.products === 2 && role !== 'p2') add('Use as product 2', () => setBand(lane, absY, 'p2'));
    if (manual && role !== 'removed') add('Automatic', () => setBand(lane, absY, 'auto'));
    const frame = els.prof.parentElement.getBoundingClientRect(), c = els.prof.getBoundingClientRect();
    m.hidden = false;
    const left = c.left - frame.left + S.X(i) + 8, top = c.top - frame.top + Math.max(PAD.t, S.Y(r.profile[i]) - 10);
    m.style.left = Math.min(left, frame.width - m.offsetWidth - 4) + 'px';
    m.style.top = Math.min(top, frame.height - m.offsetHeight - 4) + 'px';
    m.tabIndex = -1;
    m.focus();   // the first item may be destructive: Enter must not trigger it by accident
  }

  els.bandMenu.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(els.bandMenu.querySelectorAll('button'));
    const i = items.indexOf(document.activeElement);
    const j = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
    items[j].focus();
  });

  // Edit bands: every detected band of the lane in a list, each with a role (keyboard and touch friendly).
  function renderBandList(s, r) {
    const box = els.bandList;
    const open = els.editBands.getAttribute('aria-expanded') === 'true';
    box.hidden = !open || !r || r.role === 'marker' || r.role === 'excluded';
    if (box.hidden) { box.textContent = ''; return; }   // no controls left behind for a lane no longer shown
    const lane = laneAt(s.ri, s.li), b = lane.bands || {};
    const all = [];
    r.peaks.concat(r.removed || [], r.candidates || []).forEach(i => { if (!all.some(j => Math.abs(j - i) <= SAME)) all.push(i); });
    all.sort((a, c) => a - c);
    box.textContent = '';
    const table = document.createElement('table');
    all.forEach(i => {
      const absY = i + r.y0, role = bandRole(r, i);
      const manualRole = Math.abs((b.parent ?? -99) - absY) <= SAME ? 'parent'
        : (b.products || []).findIndex(v => v != null && Math.abs(v - absY) <= SAME) === 0 ? 'p1'
        : (b.products || []).findIndex(v => v != null && Math.abs(v - absY) <= SAME) === 1 ? 'p2'
        : (b.removed || []).some(v => Math.abs(v - absY) <= SAME) ? 'removed' : 'auto';
      const tr = document.createElement('tr');
      const td = (t, cls) => { const d = document.createElement('td'); if (cls) d.className = cls; if (t instanceof Node) d.appendChild(t); else d.textContent = t; tr.appendChild(d); };
      td(i + ' px', 'num');
      td(({ parent: 'parent', p1: 'product 1', p2: 'product 2', removed: 'removed', none: '' })[role]);
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', 'Role of the band at ' + i + ' px');
      [['auto', 'Automatic'], ['parent', 'Parent'], ['p1', 'Product 1'], ['p2', 'Product 2'], ['removed', 'Removed']]
        .filter(([v]) => v !== 'p2' || state.params.products === 2)
        .forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); });
      sel.value = manualRole;
      sel.addEventListener('change', () => { setBand(lane, absY, sel.value); recompute(); });
      td(sel);
      table.appendChild(tr);
    });
    box.appendChild(table);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Automatic lets the analysis decide. A removed band is never used as parent or product and its area is not counted.';
    box.appendChild(hint);
  }

  els.laneType.addEventListener('click', () => {
    const s = selIndex(), r = s && resLane(s.ri, s.li);
    if (!r) return;
    const lane = laneAt(s.ri, s.li);
    lane.role = r.role === 'marker' ? 'sample' : null;   // a lane taken for a ladder is measured anyway
    recompute();
  });

  els.editBands.addEventListener('click', () => {
    const open = els.editBands.getAttribute('aria-expanded') !== 'true';
    els.editBands.setAttribute('aria-expanded', String(open));
    renderLane();
  });

  function closeBandMenu() { els.bandMenu.hidden = true; }

  document.addEventListener('pointerdown', e => {
    if (!els.bandMenu.hidden && !e.target.closest('#bandMenu') && e.target !== els.prof) closeBandMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBandMenu(); });
  els.removeLane.addEventListener('click', removeSelectedLane);
  els.zoomBtn.addEventListener('click', () => {
    state.profZoom = !state.profZoom;
    closeBandMenu();
    els.zoomBtn.setAttribute('aria-pressed', String(state.profZoom));
    renderLane();
  });

  // Parameter help: hover or keyboard focus shows a tip; a click or tap pins it until Escape or a click elsewhere.
  const infoButtons = Array.from(document.querySelectorAll('.info'));
  const closeTips = except => infoButtons.forEach(b => { if (b !== except) b.setAttribute('aria-expanded', 'false'); });
  infoButtons.forEach(b => {
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', e => {
      e.stopPropagation();
      closeTips(b);
      b.setAttribute('aria-expanded', b.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    });
  });
  document.addEventListener('click', e => { if (!e.target.closest('.tip')) closeTips(null); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTips(null); });

  els.loadBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => { loadFile(els.fileInput.files[0]); els.fileInput.value = ''; });
  els.sampleBtn.addEventListener('click', loadSample);

  ['dragenter', 'dragover'].forEach(t => els.stage.addEventListener(t, e => { e.preventDefault(); els.stage.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(t => els.stage.addEventListener(t, e => { e.preventDefault(); els.stage.classList.remove('drag-over'); }));
  els.stage.addEventListener('drop', e => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });
  document.addEventListener('paste', e => {
    const item = Array.from((e.clipboardData && e.clipboardData.items) || []).find(i => i.type.startsWith('image/'));
    if (item) loadFile(new File([item.getAsFile()], 'pasted-image.png', { type: item.type }));
  });

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; closeBandMenu(); renderOverlay(); renderLane(); });
  });

  // ------------------------------------------------------------ export

  function baseName() { return (state.name || 'gel').replace(/\.[^.]+$/, ''); }

  function fText() { return state.params.products === 1 ? 'cut1/(parent+cut1)' : '(cut1+cut2)/(parent+cut1+cut2)'; }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function lanesForExport() {
    const labs = labels(), out = [];
    state.rows.forEach((row, ri) => row.lanes.forEach((lane, li) => {
      const r = resLane(ri, li);
      if (!r) return;
      out.push({ row: ri + 1, lane: li + 1, label: labs[ri][li], role: r.role, r });
    }));
    return out;
  }

  /** Quote for CSV and defuse text that a spreadsheet would run as a formula. */
  function csvCell(v) {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const fixed = (v, d) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '');

  function exportCsv() {
    if (!state.result) return;
    const p = state.params, lines = [];
    const note = t => lines.push(csvCell('# ' + t));
    note('T7E1 Gel Analysis ' + VERSION);
    note('file: ' + state.name + '; exported ' + new Date().toISOString());
    note('formula: Guschin 2010 100*(1-sqrt(1-f)); f = ' + fText());
    note('background: ' + p.background + '; lane width: ' + Math.round(p.laneWidth * 100) + '% of pitch; smoothing sigma: ' + p.smoothing + ' px; products: ' + p.products);
    lines.push(['row', 'lane', 'label', 'type', 'x_px', 'parent_area', 'cut1_area', 'cut2_area', 'fraction_cleaved', 'editing_pct', 'flags'].join(','));
    lanesForExport().forEach(e => {
      const r = e.r, quant = r.role !== 'marker' && r.role !== 'excluded';
      const a = quant ? r.areas : [];
      lines.push([e.row, e.lane, csvCell(e.label), r.role, r.x,
        fixed(a[0], 2), fixed(a[1], 2), fixed(a[2], 2),
        quant ? fixed(r.fc, 4) : '', quant ? fixed(r.editing, 2) : '',
        csvCell(r.flags.join('; '))].join(','));
    });
    download(new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv' }), baseName() + '-t7eI.csv');
  }

  function exportPng() {
    if (!state.result) return;
    const img = state.img, col = colors(), u = Math.max(1, img.w / 900);
    const foot = Math.round(34 * u);
    const c = document.createElement('canvas');
    c.width = img.w; c.height = img.h + foot;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(els.img, 0, 0);
    const labs = labels();
    // Text with a halo in the gel's background tone stays readable on dark and light gels.
    const darkGel = state.params.polarity === 'light';
    const ink = darkGel ? '#ffffff' : '#000000', halo = darkGel ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.85)';
    const label = (text, cx, y, fill) => {
      x.lineJoin = 'round'; x.lineWidth = 4 * u; x.strokeStyle = halo; x.strokeText(text, cx, y);
      x.fillStyle = fill; x.fillText(text, cx, y);
    };
    x.textAlign = 'center';
    state.rows.forEach((row, ri) => state.result.rows[ri].lanes.forEach((r, li) => {
      if (r.role === 'excluded') return;
      const cx = (r.a + r.b) / 2;
      x.font = `600 ${14 * u}px "Barlow Condensed", sans-serif`;
      x.textBaseline = 'bottom';
      label(labs[ri][li], cx, Math.max(16 * u, row.y0 - 4 * u), ink);
      if (r.role === 'marker') return;
      x.textBaseline = 'top';
      x.font = `600 ${15 * u}px "Barlow Condensed", sans-serif`;
      label(fmtPct(r.editing), cx, row.y1 + 4 * u, ink);   // the same tenth as the table
    }));
    const p = state.params;
    x.textAlign = 'left'; x.textBaseline = 'middle'; x.fillStyle = col.text;
    x.font = `${11 * u}px Barlow, sans-serif`;
    x.fillText('% editing, Guschin formula 100·(1−√(1−f)), ' + p.background + ' baseline' +
'. ' + state.name, 10 * u, img.h + foot / 2);
    c.toBlob(b => download(b, baseName() + '-t7eI.png'), 'image/png');
  }

  function exportXlsx() {
    if (!state.result) return;
    const p = state.params;
    const rows = [['Row', 'Lane', 'Label', 'Type', 'x (px)', 'Parent area', 'Cut 1 area', 'Cut 2 area', 'Fraction cleaved', '% editing', 'Flags']];
    lanesForExport().forEach(e => {
      const r = e.r, quant = r.role !== 'marker' && r.role !== 'excluded';
      const num = (v, d) => (typeof v === 'number' && isFinite(v) ? Number(v.toFixed(d)) : null);
      rows.push([e.row, e.lane, e.label, r.role, r.x,
        quant ? num(r.areas[0], 2) : null, quant ? num(r.areas[1], 2) : null, quant ? num(r.areas[2], 2) : null,
        quant ? num(r.fc, 4) : null, quant ? num(r.editing, 2) : null, r.flags.join('; ')]);
    });
    const settings = [['Setting', 'Value'],
      ['App', 'T7E1 Gel Analysis ' + VERSION], ['File', state.name], ['Exported', new Date().toISOString()],
      ['Formula', '% editing = 100*(1-sqrt(1-f)), f = ' + fText() + ' (Guschin 2010, NEB)'],
      ['Background', p.background], ['Lane width (% of pitch)', Math.round(p.laneWidth * 100)],
      ['Smoothing sigma (px)', p.smoothing], ['Cleavage products', p.products],
      ['Image', state.img.w + ' x ' + state.img.h + ' px, ' + state.img.bits + '-bit' + (state.img.storedBits > state.img.bits ? ' data in a ' + state.img.storedBits + '-bit file' : '')]];
    const data = XLSX.build([
      { name: 'Results', rows, widths: [6, 6, 10, 9, 8, 12, 11, 11, 15, 11, 60] },
      { name: 'Settings', rows: settings, widths: [26, 70] }
    ]);
    download(new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), baseName() + '-t7eI.xlsx');
  }

  els.csvBtn.addEventListener('click', exportCsv);
  els.xlsxBtn.addEventListener('click', exportXlsx);
  els.pngBtn.addEventListener('click', exportPng);

  // ------------------------------------------------------------ start

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
  loadSample();
})();
