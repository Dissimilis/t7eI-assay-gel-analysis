// The app in headless Chrome, on its built-in synthetic gel: band editing, undo and reset, menus,
// setting changes, exports and image loading. Skipped when no Chrome is installed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { findChrome, serve, launch, ROOT } = require('./browser/driver.js');

const chrome = findChrome();

test('the app in a browser', { skip: !chrome && 'no Chrome found (set CHROME_PATH)', timeout: 120000 }, async t => {
  const { server, url } = await serve();
  const page = await launch(chrome);
  try {
    await page.go(url + 'index.html');
    // Catch downloads instead of saving them.
    await page.eval(`(() => { window.__blobs = []; const o = URL.createObjectURL; URL.createObjectURL = b => { window.__blobs.push(b); return o.call(URL, b); }; HTMLAnchorElement.prototype.click = function () {}; })()`);
    const table = () => page.eval(`Array.from(document.querySelectorAll('#resBody tr')).map(tr => tr.innerText.replace(/\\s+/g, ' ').trim())`);
    const ed = () => page.eval(`document.getElementById('stEd').textContent`);
    const flags = () => page.eval(`document.getElementById('selFlags').textContent`);
    const message = () => page.eval(`document.getElementById('imgMeta').textContent`);
    const menuOpen = () => page.eval(`!document.getElementById('bandMenu').hidden`);
    const disabled = id => page.eval(`document.getElementById('${id}').disabled`);
    const pick = i => page.eval(`document.querySelectorAll('#laneChips button')[${i}].click()`);
    const bandRows = () => page.eval(`Array.from(document.querySelectorAll('#bandList tr')).map(tr => ({ y: tr.children[0].textContent, role: tr.children[1].textContent, value: tr.querySelector('select').value }))`);
    const setBand = (role, to) => page.eval(`(() => { const tr = Array.from(document.querySelectorAll('#bandList tr')).find(t => t.children[1].textContent === '${role}'); const s = tr.querySelector('select'); s.value = '${to}'; s.dispatchEvent(new Event('change')); })()`);
    const openMenu = async () => {
      const box = await page.eval(`(() => { const r = document.getElementById('profCanvas').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
      for (let x = box[0] + 40; x < box[0] + box[2] - 20; x += 3) {
        for (const y of [box[1] + 0.3 * box[3], box[1] + 0.6 * box[3]]) { await page.click(x, y); if (await menuOpen()) return true; }
      }
      return false;
    };
    const radio = (name, value) => page.eval(`(() => { const r = document.querySelector('input[name=${name}][value="${value}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })()`);

    await t.test('the sample gel loads with results', async () => {
      const rows = await table();
      assert.ok(rows.length >= 20, 'lanes in the table: ' + rows.length);
      assert.ok(rows.some(r => /\d+\.\d/.test(r)), 'some lane shows a % editing');
    });

    let before, lane;
    await t.test('removing a product in the band list changes only that lane', async () => {
      before = await table();
      lane = 3;
      await pick(lane);
      const auto = await ed();
      await page.eval(`document.getElementById('editBands').click()`);
      assert.ok((await bandRows()).some(b => b.role === 'product 1'), 'band list shows the products');
      await setBand('product 1', 'removed');
      await page.sleep(200);
      assert.notEqual(await ed(), auto, 'the lane value changes');
      assert.match(await flags(), /manual band assignment|bands set/);
      assert.ok((await bandRows()).some(b => b.role === 'removed'), 'the band is listed as removed');
      const after = await table();
      after.forEach((r, i) => { if (i !== lane) assert.equal(r, before[i], 'table row ' + i); });
    });

    await t.test('undo and reset bring the automatic result back', async () => {
      await page.eval(`document.getElementById('undoBands').click()`);
      await page.sleep(200);
      assert.deepEqual(await table(), before, 'undo restores the table');
      assert.equal(await disabled('undoBands'), true, 'nothing left to undo');
      await setBand('product 1', 'removed');
      await page.eval(`document.getElementById('resetBands').click()`);
      await page.sleep(200);
      assert.deepEqual(await table(), before, 'reset restores the table');
    });

    await t.test('a click on a peak opens the band menu; Escape and zoom close it', async () => {
      assert.ok(await openMenu(), 'band menu opened on a peak');
      await page.key('Escape', 27);
      assert.equal(await menuOpen(), false, 'Escape closes the menu');
      assert.ok(await openMenu(), 'band menu opened again');
      const items = await page.eval(`Array.from(document.querySelectorAll('#bandMenu button')).map(b => b.textContent)`);
      assert.ok(items.some(s => /Remove/.test(s)), 'menu offers Remove: ' + items.join(', '));
      await page.eval(`document.getElementById('zoomBtn').click()`);
      assert.equal(await menuOpen(), false, 'zoom closes the menu');
      await page.eval(`document.getElementById('zoomBtn').click()`);
    });

    await t.test('a product-count change clears hand edits and says so', async () => {
      await setBand('product 1', 'removed');
      await radio('products', '1');
      await page.sleep(300);
      assert.match(await message(), /Product count changed/);
      assert.equal(await disabled('undoBands'), true, 'undo history cleared');
      await radio('products', '2');
      await page.sleep(300);
      assert.deepEqual(await table(), before, 'two products again gives the first result');
    });

    await t.test('a polarity change finds the lanes again and says so after edits', async () => {
      await pick(lane);
      await page.eval(`document.getElementById('editBands').click()`);
      await setBand('product 1', 'removed');
      await radio('polarity', 'light');
      await page.sleep(400);
      assert.match(await message(), /Lanes found again/);
      await radio('polarity', 'dark');
      await page.sleep(400);
      assert.deepEqual(await table(), before, 'back to dark bands gives the first result');
    });

    await t.test('CSV, XLSX and PNG exports', async () => {
      await page.eval(`window.__blobs.length = 0`);
      for (const id of ['csvBtn', 'xlsxBtn', 'pngBtn']) { await page.eval(`document.getElementById('${id}').click()`); await page.sleep(400); }
      const info = await page.eval(`Promise.all(window.__blobs.map(async b => { const u = new Uint8Array(await b.arrayBuffer()); return { type: b.type, head: Array.from(u.slice(0, 4)), text: b.type === 'text/csv' ? new TextDecoder().decode(u) : '' }; }))`);
      const csv = info.find(b => b.type === 'text/csv'), png = info.find(b => b.type === 'image/png'), xlsx = info.find(b => b !== csv && b !== png);
      assert.ok(csv && png && xlsx, 'three downloads: ' + info.map(b => b.type).join(', '));
      assert.deepEqual(csv.head.slice(0, 3), [0xef, 0xbb, 0xbf], 'CSV starts with a UTF-8 BOM');
      const dataLines = csv.text.split(/\r\n/).filter(l => l && !l.startsWith('#') && !l.startsWith('﻿#') && !/^row,/.test(l));
      assert.equal(dataLines.length, before.length, 'one CSV line per lane');
      assert.deepEqual(xlsx.head, [0x50, 0x4b, 0x03, 0x04], 'XLSX is a zip');
      // The numbers match the table: parent area and % editing of every lane.
      const shown = await page.eval(`Array.from(document.querySelectorAll('#resBody tr')).map(tr => [tr.querySelector('td.num').textContent, tr.querySelector('td.ed-val').textContent])`);
      const head = csv.text.split('\r\n').map(l => l.replace('\ufeff', '')).find(l => l.startsWith('row,')).split(',');
      const col = name => head.indexOf(name);
      dataLines.forEach((line, i) => {
        const c = line.split(',');
        const parent = c[col('parent_area')], ed = c[col('editing_pct')];
        // Two decimals in the file, one on screen, both rounded from the same value.
        const near = (v, txt) => (v == null ? txt === '—' : Math.abs(v - Number(txt)) <= 0.051);
        assert.ok(near(ed === '' ? null : Number(ed), shown[i][1]), `CSV % editing, lane ${i}: ${ed} vs ${shown[i][1]}`);
        // The table rounds the raw area, the CSV keeps two decimals of it: they agree to half a unit.
        if (parent !== '') assert.ok(Math.abs(Number(parent) - Number(shown[i][0].replace(/[^0-9.]/g, ''))) <= 0.51, `CSV parent area, lane ${i}: ${parent} vs ${shown[i][0]}`);
      });
      const sheet = await page.eval(`(async () => { const b = window.__blobs.find(x => /spreadsheetml/.test(x.type)); return new TextDecoder('latin1').decode(new Uint8Array(await b.arrayBuffer())); })()`);
      const cell = (colName, r) => { const m = sheet.match(new RegExp('<c r="' + colName + r + '"[^>]*><v>([^<]+)</v>')); return m ? Number(m[1]) : null; };
      shown.forEach((s, i) => {
        const e = cell('J', i + 2);
        assert.ok(e == null ? s[1] === '—' : Math.abs(e - Number(s[1])) <= 0.051, `XLSX % editing, lane ${i}: ${e} vs ${s[1]}`);
      });
      assert.deepEqual(png.head, [0x89, 0x50, 0x4e, 0x47], 'PNG signature');
    });

    await t.test('removing a lane drops it from the table', async () => {
      await pick(lane);
      await page.eval(`document.getElementById('removeLane').click()`);
      await page.sleep(200);
      assert.equal((await table()).length, before.length - 1);
    });

    await t.test('loading another image replaces the gel; the sample comes back clean', async () => {
      await page.setFiles('#fileInput', [path.join(ROOT, 'tests', 'fixtures', 'gray8-raw.tif')]);
      await page.sleep(800);
      assert.match(await page.eval(`document.getElementById('fileName').textContent`), /gray8-raw/);
      await page.eval(`document.getElementById('sampleBtn').click()`);
      await page.sleep(600);
      assert.deepEqual(await table(), before, 'the sample gives the first result again');
      assert.equal(await menuOpen(), false);
    });

    await t.test('a window resize closes an open band menu', async () => {
      await pick(lane);
      assert.ok(await openMenu(), 'band menu opened');
      await page.size(1200, 900);
      await page.sleep(300);
      assert.equal(await menuOpen(), false);
      await page.size(1440, 1000);
    });

    await t.test('no errors in the console', async () => {
      assert.deepEqual(page.errors, []);
    });
  } finally {
    await page.close();
    server.close();
  }
});
