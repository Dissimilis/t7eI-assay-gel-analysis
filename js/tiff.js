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

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function isTiff(buf) {
    const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    return b.length === 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) ||
                              (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42));
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
      if (prev === -1) { write(code); prev = code; continue; }
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
    return out;
  }

  async function inflate(input) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Deflate-compressed TIFF needs a browser with DecompressionStream');
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function decompress(bytes, compression, expected) {
    if (compression === 1) return bytes;
    if (compression === 5) return lzw(bytes, expected);
    if (compression === 32773) return packBits(bytes, expected);
    if (compression === 8 || compression === 32946) return inflate(bytes);
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
    if (!isTiff(buf)) throw new Error('Not a TIFF file');
    const dv = new DataView(buf);
    const le = dv.getUint8(0) === 0x49;
    const t = readIfd(dv, le);
    const w = t[256][0], h = t[257][0];
    const spp = (t[277] || [1])[0], bps = (t[258] || [1])[0];
    const compression = (t[259] || [1])[0], photometric = (t[262] || [1])[0];
    const predictor = (t[317] || [1])[0], format = (t[339] || [1])[0], planar = (t[284] || [1])[0];
    if (planar !== 1 && spp > 1) throw new Error('Planar TIFF is not supported');
    if (![8, 16, 32].includes(bps)) throw new Error('Unsupported TIFF bit depth ' + bps);
    if (bps === 32 && format !== 3) throw new Error('32-bit integer TIFF is not supported');
    const bpp = (bps / 8) * spp, rowBytes = w * bpp;
    const raw = new Uint8Array(rowBytes * h);

    if (t[324]) {
      const tw = t[322][0], th = t[323][0], across = Math.ceil(w / tw);
      for (let i = 0; i < t[324].length; i++) {
        const src = new Uint8Array(buf, t[324][i], t[325][i]);
        const tile = await decompress(src, compression, tw * th * bpp);
        if (predictor === 2) unpredict(tile, tw * bpp, th, bps, spp, le);
        const tx = (i % across) * tw, ty = Math.floor(i / across) * th;
        for (let y = 0; y < th && ty + y < h; y++) {
          const n = Math.min(tw, w - tx) * bpp;
          raw.set(tile.subarray(y * tw * bpp, y * tw * bpp + n), (ty + y) * rowBytes + tx * bpp);
        }
      }
    } else {
      const rps = (t[278] || [h])[0];
      for (let i = 0; i < t[273].length; i++) {
        const rows = Math.min(rps, h - i * rps);
        const src = new Uint8Array(buf, t[273][i], t[279][i]);
        const strip = await decompress(src, compression, rows * rowBytes);
        if (predictor === 2) unpredict(strip, rowBytes, rows, bps, spp, le);
        raw.set(strip.subarray(0, rows * rowBytes), i * rps * rowBytes);
      }
    }

    const rdv = new DataView(raw.buffer);
    const sample = bps === 8 ? i => raw[i] : bps === 16 ? i => rdv.getUint16(2 * i, le) : i => rdv.getFloat32(4 * i, le);
    const gray = new Float32Array(w * h);
    let lo = 0, hi = bps === 8 ? 255 : 65535;
    if (bps === 32) {
      lo = Infinity; hi = -Infinity;
      for (let i = 0; i < w * h * spp; i++) { const v = sample(i); if (v < lo) lo = v; if (v > hi) hi = v; }
      if (hi === lo) hi = lo + 1;
    }
    const scale = 255 / (hi - lo);
    for (let p = 0; p < w * h; p++) {
      let v;
      if (spp >= 3) v = 0.299 * sample(p * spp) + 0.587 * sample(p * spp + 1) + 0.114 * sample(p * spp + 2);
      else v = sample(p * spp);
      v = (v - lo) * scale;
      gray[p] = photometric === 0 ? 255 - v : v;
    }
    const step = 255 / (hi - lo);   // one raw unit on the 0-255 scale
    return { w, h, gray, bits: bps, clipLow: bps === 8 ? 3 : 0.5 * step, clipHigh: bps === 8 ? 252 : 255 - 0.5 * step };
  }

  return { isTiff, decode, lzw, packBits };
});
