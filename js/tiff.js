/*
 * Minimal baseline TIFF reader for gel images (first page only).
 *
 * Supports 8/16-bit integer and 32-bit float samples, grayscale or RGB(A),
 * strips or tiles, no compression, LZW, PackBits and Deflate, with or without
 * the horizontal predictor. Returns luminance scaled to 0-255 floats, so 16-bit
 * data keeps its precision.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.T7E1Tiff = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_PIXELS = 40e6;
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function isTiff(buf) {
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    return b.length === 4 && ((b[0] === 0x49 && b[1] === 0x49 && (b[2] === 42 || b[2] === 43) && b[3] === 0) ||
                              (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && (b[3] === 42 || b[3] === 43)));
  }

  function readIfd(dv, le) {
    const tags = {};
    const off = dv.getUint32(4, le);
    const n = dv.getUint16(off, le);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
      const size = (TYPE_SIZE[type] || 1) * count;
      const at = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      const vals = [];
      for (let k = 0; k < count && k < 1e6; k++) {
        if (type === 3) vals.push(dv.getUint16(at + 2 * k, le));
        else if (type === 4) vals.push(dv.getUint32(at + 4 * k, le));
        else if (type === 1 || type === 7) vals.push(dv.getUint8(at + k));
        else if (type === 5) vals.push(dv.getUint32(at + 8 * k, le) / dv.getUint32(at + 8 * k + 4, le));
        else break;
      }
      tags[tag] = vals;
    }
    return tags;
  }

  function lzw(input, expected) {
    const out = new Uint8Array(expected);
    const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Uint16Array(4096);
    for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; len[i] = 1; }
    let op = 0, bit = 0, width = 9, next = 258, prev = -1;
    const total = input.length * 8;
    const write = code => {
      const L = len[code];
      let c = code;
      for (let i = L - 1; i >= 0; i--) { if (op + i < expected) out[op + i] = suffix[c]; c = prefix[c]; }
      op += L;
    };
    while (bit + width <= total && op < expected) {
      let code = 0;
      for (let i = 0; i < width; i++, bit++) code = (code << 1) | ((input[bit >> 3] >> (7 - (bit & 7))) & 1);
      if (code === 257) break;
      if (code === 256) { width = 9; next = 258; prev = -1; continue; }
      if (prev === -1) {
        if (code > 255) throw new Error('corrupt LZW data');
        write(code); prev = code; continue;
      }
      if (code > next || next >= 4096) throw new Error('corrupt LZW data');
      if (code < next) {
        write(code);
        prefix[next] = prev; suffix[next] = first[code]; first[next] = first[prev]; len[next] = len[prev] + 1;
      } else {
        prefix[next] = prev; suffix[next] = first[prev]; first[next] = first[prev]; len[next] = len[prev] + 1;
        write(next);
      }
      next++;
      prev = code;
      if (next >= (1 << width) - 1 && width < 12) width++;
    }
    if (op < expected) throw new Error('truncated LZW data');
    return out;
  }

  function packBits(input, expected) {
    const out = new Uint8Array(expected);
    let i = 0, o = 0;
    while (i < input.length && o < expected) {
      const n = (input[i++] << 24) >> 24;
      if (n >= 0) { for (let k = 0; k <= n && o < expected; k++) out[o++] = input[i++]; }
      else if (n !== -128) { const v = input[i++]; for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = v; }
    }
    if (o < expected || i > input.length) throw new Error('truncated PackBits data');
    return out;
  }

  async function inflate(input, expected) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Deflate-compressed TIFF needs a browser with DecompressionStream');
    const reader = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const out = new Uint8Array(expected);
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > expected) { out.set(value.subarray(0, expected - n), n); n = expected; await reader.cancel(); break; }
      out.set(value, n);
      n += value.length;
    }
    if (n < expected) throw new Error('truncated Deflate data');
    return out;
  }

  async function decompress(bytes, compression, expected) {
    if (compression === 1) { if (bytes.length < expected) throw new Error('truncated image data'); return bytes.slice(0, expected); }
    if (compression === 5) return lzw(bytes, expected);
    if (compression === 32773) return packBits(bytes, expected);
    if (compression === 8 || compression === 32946) return inflate(bytes, expected);
    throw new Error('Unsupported TIFF compression ' + compression + ' (use uncompressed, LZW, PackBits or Deflate)');
  }

  function unpredict(block, rowBytes, rows, bps, spp, le) {
    if (bps === 8) {
      for (let r = 0; r < rows; r++) for (let i = r * rowBytes + spp; i < (r + 1) * rowBytes; i++) block[i] = (block[i] + block[i - spp]) & 255;
    } else if (bps === 16) {
      const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
      for (let r = 0; r < rows; r++) {
        for (let i = r * rowBytes + 2 * spp; i + 1 < (r + 1) * rowBytes; i += 2) {
          dv.setUint16(i, (dv.getUint16(i, le) + dv.getUint16(i - 2 * spp, le)) & 0xffff, le);
        }
      }
    }
  }

  async function decode(buf) {
    const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (head.length === 4 && (head[2] === 43 || head[3] === 43) && (head[0] === 0x49 || head[0] === 0x4d)) throw new Error('BigTIFF files are not supported: save as a regular TIFF');
    if (!isTiff(buf)) throw new Error('Not a TIFF file');
    try {
      return await decodeTiff(buf);
    } catch (err) {
      if (err instanceof RangeError) throw new Error('the TIFF file is truncated or damaged');
      throw err;
    }
  }

  async function decodeTiff(buf) {
    const dv = new DataView(buf);
    const le = dv.getUint8(0) === 0x49;
    const t = readIfd(dv, le);
    const one = (tag, def) => (t[tag] && t[tag].length ? t[tag][0] : def);
    const w = one(256), h = one(257);
    if (!(w > 0 && h > 0)) throw new Error('the TIFF file has no image size');
    if (w * h > MAX_PIXELS) throw new Error('the image is ' + Math.round(w * h / 1e6) + ' megapixels; the limit is ' + MAX_PIXELS / 1e6 + ' MP. Crop it first.');
    const spp = one(277, 1), bps = one(258, 1);
    const compression = one(259, 1), photometric = one(262, 1);
    const predictor = one(317, 1), format = one(339, 1), planar = one(284, 1);
    if ((t[258] || []).some(b => b !== bps)) throw new Error('TIFF channels with different bit depths are not supported');
    if (planar !== 1 && spp > 1) throw new Error('planar TIFF is not supported');
    if (photometric === 3) throw new Error('palette (indexed colour) TIFF is not supported: save the gel as grayscale');
    if (![0, 1, 2].includes(photometric)) throw new Error('TIFF colour model ' + photometric + ' is not supported');
    if (photometric === 2 && spp < 3) throw new Error('RGB TIFF with ' + spp + ' channels is not supported');
    if (![8, 16, 32].includes(bps)) throw new Error('TIFF bit depth ' + bps + ' is not supported');
    if (bps === 32 ? format !== 3 : format !== 1) throw new Error('signed or integer 32-bit TIFF samples are not supported');
    if (predictor !== 1 && !(predictor === 2 && bps !== 32)) throw new Error('TIFF predictor ' + predictor + ' is not supported');
    const tiled = !!t[324];
    if (tiled ? !(t[322] && t[323] && t[325]) : !(t[273] && t[279])) throw new Error('the TIFF file lacks its image data tags');
    const offsets = tiled ? t[324] : t[273], counts = tiled ? t[325] : t[279];
    for (let i = 0; i < offsets.length; i++) {
      if (counts[i] === undefined || offsets[i] + counts[i] > buf.byteLength) throw new Error('the TIFF file is truncated or damaged');
    }
    const bpp = (bps / 8) * spp, rowBytes = w * bpp;
    const raw = new Uint8Array(rowBytes * h);

    if (tiled) {
      const tw = t[322][0], th = t[323][0];
      if (!(tw > 0 && th > 0 && tw * th <= MAX_PIXELS)) throw new Error('the TIFF file has an invalid tile size');
      const across = Math.ceil(w / tw), need = across * Math.ceil(h / th);
      if (offsets.length < need) throw new Error('the TIFF file is missing image tiles');
      for (let i = 0; i < need; i++) {
        const tile = await decompress(new Uint8Array(buf, offsets[i], counts[i]), compression, tw * th * bpp);
        if (predictor === 2) unpredict(tile, tw * bpp, th, bps, spp, le);
        const tx = (i % across) * tw, ty = Math.floor(i / across) * th;
        for (let y = 0; y < th && ty + y < h; y++) {
          const n = Math.min(tw, w - tx) * bpp;
          raw.set(tile.subarray(y * tw * bpp, y * tw * bpp + n), (ty + y) * rowBytes + tx * bpp);
        }
      }
    } else {
      const rps = Math.min(one(278, h) || h, h), need = Math.ceil(h / rps);
      if (offsets.length < need) throw new Error('the TIFF file is missing image strips');
      for (let i = 0; i < need; i++) {
        const rows = Math.min(rps, h - i * rps);
        const strip = await decompress(new Uint8Array(buf, offsets[i], counts[i]), compression, rows * rowBytes);
        if (predictor === 2) unpredict(strip, rowBytes, rows, bps, spp, le);
        raw.set(strip.subarray(0, rows * rowBytes), i * rps * rowBytes);
      }
    }

    const rdv = new DataView(raw.buffer);
    const sample = bps === 8 ? i => raw[i] : bps === 16 ? i => rdv.getUint16(2 * i, le) : i => rdv.getFloat32(4 * i, le);
    const total = w * h * spp;
    let lo = 0, hi = 255, bits = bps;
    let clipTop = null, clipBottom = null, quantum = 1;
    if (bps === 16) {
      // Cameras often store 12- or 14-bit data in 16-bit files, right- or left-aligned. A sensor
      // that clipped leaves a pile of pixels at one value: that value is the real ceiling.
      const hist = new Uint32Array(65536);
      let max = 0, min = 65535, used = 0;
      for (let i = 0; i < total; i++) { const v = sample(i); hist[v]++; used |= v; if (v > max) max = v; if (v < min) min = v; }
      quantum = used ? used & -used : 1;   // left-aligned 12-bit data only uses every 16th value
      const pile = (v, dir) => {
        if (hist[v] < Math.max(20, total * 2e-5)) return false;
        let sum = 0, n = 0;
        for (let k = 1; k <= 8; k++) { const u = v - dir * k * quantum; if (u < 0 || u > 65535) break; sum += hist[u]; n++; }
        return n > 0 && hist[v] > 5 * (sum / n) + 5;
      };
      for (let v = max; v >= 0.15 * max && v > min; v -= quantum) if (hist[v] && pile(v, 1)) { clipTop = v; break; }
      if (pile(min, -1)) clipBottom = min;
      const ceiling = clipTop != null ? clipTop : max;
      bits = [10, 12, 14, 16].find(b => ceiling <= 2 ** b - 1);
      hi = 2 ** bits - 1;
    } else if (bps === 32) {
      lo = Infinity; hi = -Infinity;
      for (let i = 0; i < total; i++) { const v = sample(i); if (v < lo) lo = v; if (v > hi) hi = v; }
      if (!(hi > lo)) hi = lo + 1;
    }
    const scale = 255 / (hi - lo);
    const gray = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) {
      let v;
      if (spp >= 3) v = 0.299 * sample(p * spp) + 0.587 * sample(p * spp + 1) + 0.114 * sample(p * spp + 2);
      else v = sample(p * spp);
      v = (v - lo) * scale;
      gray[p] = photometric === 0 ? 255 - v : v;
    }
    if (bps === 32) {
      // Float data has no fixed full scale, so clipping cannot be detected.
      return { w, h, gray, bits, clipLow: -Infinity, clipHigh: Infinity, saturationUnknown: true };
    }
    if (bps === 8) return { w, h, gray, bits, clipLow: 3, clipHigh: 252 };
    const half = 0.5 * quantum * scale;   // half a raw step on the 0-255 scale
    const toGray = v => (photometric === 0 ? 255 - v * scale : v * scale);
    let clipLow = half, clipHigh = 255 - half;
    // Map raw piles to the grey scale; WhiteIsZero swaps which end is which.
    const ends = [clipTop, clipBottom].filter(v => v != null).map(toGray);
    ends.forEach(g => { if (g > 127) clipHigh = Math.min(clipHigh, g - half); else clipLow = Math.max(clipLow, g + half); });
    return { w, h, gray, bits, clipLow, clipHigh };
  }

  return { isTiff, decode, lzw, packBits };
});
