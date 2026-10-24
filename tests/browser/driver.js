// Minimal headless Chrome driver over the DevTools protocol, plus a static server for the app.
// No dependencies: Node 22's fetch and WebSocket talk to Chrome directly.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

function findChrome() {
  const list = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return list.find(p => p && fs.existsSync(p)) || null;
}

/** Serve the repository root on a free port. */
function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Start Chrome headless and return a page handle: eval, click, mouse, setFiles, errors, close. */
async function launch(chrome) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 't7ei-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 600);
  const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--window-size=1440,1000', 'about:blank'];
  if (process.env.CI) args.unshift('--no-sandbox');
  const proc = spawn(chrome, args, { stdio: 'ignore' });
  let targets = [];
  for (let i = 0; i < 300 && !targets.some(t => t.type === 'page'); i++) {   // up to 30 s: CI runners can be slow to start Chrome
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch (e) { /* not up yet */ }
    if (!targets.some(t => t.type === 'page')) await sleep(100);
  }
  const target = targets.find(t => t.type === 'page');
  if (!target) { proc.kill(); throw new Error('Chrome did not start'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = {}, errors = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; }
    if (d.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) errors.push(d.params.type + ': ' + d.params.args.map(a => a.value || a.description).join(' '));
    if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push('log: ' + d.params.entry.text);
  };
  const send = (method, params = {}) => new Promise(resolve => { const i = ++id; pending[i] = resolve; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const page = {
    errors, sleep,
    async go(url) { await send('Page.navigate', { url }); await sleep(800); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error('page: ' + (r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text));
      return r.result.result.value;
    },
    async mouse(type, x, y) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); },
    async click(x, y) { await page.mouse('mousePressed', x, y); await page.mouse('mouseReleased', x, y); },
    async key(key, code) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code }); },
    async setFiles(selector, files) {
      const doc = await send('DOM.getDocument', {});
      const node = (await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector })).result.nodeId;
      await send('DOM.setFileInputFiles', { nodeId: node, files });
    },
    async size(width, height) { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); },
    async close() {
      try { ws.close(); } catch (e) { /* already closed */ }
      proc.kill();
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome may still hold files */ }
    }
  };
  return page;
}

module.exports = { findChrome, serve, launch, ROOT };
