// Memory stress test: closes anchored tabs, normal tabs and whole windows
// hundreds of times, then checks that the service worker's bookkeeping and
// JS heap don't grow.
// Run: node tests/stress.js   (needs the `playwright` package and its Chromium)
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.tmpdir(), 'anchored-tabs-stress-profile');
const PORT = 9300 + Math.floor(Math.random() * 500);
const ROUNDS = 3;
const CYCLES = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Page ${req.url}</title>`);
});

/** Minimal DevTools Protocol client for the extension's service worker. */
async function devtools(extId) {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('service worker target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return {
    async heapMB() {
      await call('HeapProfiler.collectGarbage');
      await sleep(100);
      await call('HeapProfiler.collectGarbage');
      const { usedSize } = await call('Runtime.getHeapUsage');
      return usedSize / 1024 / 1024;
    },
    close: () => ws.close(),
  };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${server.address().port}`;
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--remote-debugging-port=${PORT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  // Playwright's Chromium build segfaults on chrome.tabs.discard; make it a no-op.
  await sw.evaluate(() => {
    chrome.tabs.discard = async (id) => chrome.tabs.get(id);
  });
  const ui = await ctx.newPage();
  await ui.goto(`chrome-extension://${extId}/src/options.html`);
  const stats = () => ui.evaluate(() => import('./shared.js').then((m) => m.send('debugStats')));
  const ev = (fn, arg) => sw.evaluate(fn, arg);
  const dt = await devtools(extId);
  await sleep(2500);

  const win = (await ev(() => chrome.tabs.query({ active: true })))[0].windowId;
  const home = await ev(([u, w]) => chrome.tabs.create({ url: u, windowId: w }), [`${B}/home`, win]);
  await ev(([u, w]) => chrome.tabs.create({ url: u, windowId: w, pinned: true }), [`${B}/pinned`, win]);
  await sleep(1500);

  const pinnedTab = async () => (await ev((w) => chrome.tabs.query({ pinned: true, windowId: w }), win))[0];
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      const s = await stats();
      if (s.hibernating === 0 && s.waiters === 0) return;
      await sleep(100);
    }
  };

  const rows = [];
  const record = async (label) => {
    await settle();
    await sleep(1200); // let debounced writes and snapshots finish
    rows.push({ round: label, heapMB: +(await dt.heapMB()).toFixed(2), ...(await stats()) });
  };
  await record('baseline');

  for (let round = 1; round <= ROUNDS; round++) {
    for (let i = 0; i < CYCLES; i++) {
      // 1. Close the active anchored pinned tab → recreate + hibernate.
      const p = await pinnedTab();
      await ev((id) => chrome.tabs.update(id, { active: true }), p.id);
      await ev((id) => chrome.tabs.remove(id), p.id);
      for (let k = 0; k < 50; k++) {
        const q = await pinnedTab();
        if (q && q.id !== p.id) break;
        await sleep(20);
      }
      // 2. Open and close a normal tab.
      const t = await ev(([u, w]) => chrome.tabs.create({ url: u, windowId: w, active: true }), [`${B}/n${i}`, win]);
      await ev((id) => chrome.tabs.remove(id), t.id);
      // 3. Every 5th cycle, open and close a whole window.
      if (i % 5 === 0) {
        const w = await ev((u) => chrome.windows.create({ url: [u + '/w1', u + '/w2'] }), B);
        await ev((id) => chrome.tabs.update(id, { active: true }), w.tabs[1].id);
        await ev((id) => chrome.windows.remove(id), w.id);
      }
    }
    await ev((id) => chrome.tabs.update(id, { active: true }), home.id);
    await record(`round ${round}`);
  }

  console.table(rows);

  let failures = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
  };
  const last = rows[rows.length - 1];
  const first = rows[1];
  check('tabMap only holds open anchored tabs', last.tabMap === last.anchors, `${last.tabMap} vs ${last.anchors}`);
  check('per-tab maps bounded by open tabs', last.seen <= last.tabs && last.sleeping <= last.tabs, `seen=${last.seen} sleeping=${last.sleeping} tabs=${last.tabs}`);
  check('per-window maps bounded by open windows', last.active <= last.windows && last.prevActive <= last.windows, `active=${last.active} prevActive=${last.prevActive} windows=${last.windows}`);
  check('nothing stuck hibernating', last.hibernating === 0 && last.waiters === 0 && last.freeSlots === 3);
  check('session storage flat across rounds', Math.abs(last.sessionBytes - first.sessionBytes) < 256, `${first.sessionBytes} → ${last.sessionBytes} bytes`);
  check('service worker heap flat across rounds', last.heapMB - first.heapMB < 1, `${first.heapMB} → ${last.heapMB} MB`);

  dt.close();
  await ctx.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
