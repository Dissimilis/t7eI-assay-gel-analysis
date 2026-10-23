'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../js/xlsx.js');

test('CRC-32 matches the standard check value', () => {
  assert.equal(X.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('column names', () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(X.colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('workbook is a valid zip with the expected parts and escaped cells', () => {
  const data = X.build([
    { name: 'Results', rows: [['Lane', '% editing', 'Flags'], [1, 21.75, 'a & <b> "c"'], [2, NaN, '=1+1']], widths: [6, 10, 30] },
    { name: 'Settings', rows: [['Formula', 'Guschin']] }
  ]);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50, 'local file header');
  const eocd = data.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, 'end of central directory');
  const entries = dv.getUint16(eocd + 10, true);
  assert.equal(entries, 7);
  // Walk the local headers, check each stored part's CRC and collect names.
  const names = [];
  let o = 0, text = '';
  for (let i = 0; i < entries; i++) {
    const crc = dv.getUint32(o + 14, true), size = dv.getUint32(o + 18, true), nameLen = dv.getUint16(o + 26, true);
    const name = new TextDecoder().decode(data.subarray(o + 30, o + 30 + nameLen));
    const body = data.subarray(o + 30 + nameLen, o + 30 + nameLen + size);
    assert.equal(X.crc32(body), crc, 'crc of ' + name);
    names.push(name);
    if (name === 'xl/worksheets/sheet1.xml') text = new TextDecoder().decode(body);
    o += 30 + nameLen + size;
  }
  assert.ok(names.includes('[Content_Types].xml') && names.includes('xl/workbook.xml') && names.includes('xl/worksheets/sheet2.xml'));
  assert.match(text, /<v>21\.75<\/v>/);
  assert.match(text, /a &amp; &lt;b&gt; &quot;c&quot;/);
  assert.match(text, /<t xml:space="preserve">=1\+1<\/t>/, 'text starting with = stays text');
  assert.doesNotMatch(text, /NaN/);
});
