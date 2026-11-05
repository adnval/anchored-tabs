// End-to-end test: loads the extension into Playwright Chromium and walks
// through close/reset/hibernate, focus, groups, URL editing and restarts.
// Run: node tests/e2e.js   (needs the `playwright` package and its Chromium)
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..');
const PROFILE = path.join(require('os').tmpdir(), 'anchored-tabs-e2e-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
}

const server = http.createServer((req, res) => {
  const name = req.url.slice(1) || 'root';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>Page ${name}</title><h1>${name}</h1>`);
});

async function launch(args = []) {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium', headless: process.env.HEADED ? false : true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, ...args],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  // Playwright's Chromium build segfaults on chrome.tabs.discard, so record
  // discards instead and treat activation as waking the tab up.
  await sw.evaluate(() => {
    globalThis.__zz = new Set();
    chrome.tabs.discard = async (id) => { __zz.add(id); return chrome.tabs.get(id); };
    chrome.tabs.onActivated.addListener(({ tabId }) => __zz.delete(tabId));
    chrome.tabs.onRemoved.addListener((id) => __zz.delete(id));
  });
  // A page inside the extension so we can use the message API like the popup does.
  const ui = await ctx.newPage();
  await ui.goto(`chrome-extension://${extId}/src/options.html`);
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  return { ctx, sw, ui, errors };
}

const call = (ui, type, payload = {}) =>
  ui.evaluate(([type, payload]) => import('./shared.js').then((m) => m.send(type, payload)), [type, payload]);
const tabs = (sw, q = {}) => sw.evaluate(async (q) => (await chrome.tabs.query(q)).map((t) => ({ ...t, discarded: __zz.has(t.id) })), q);
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return v;
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${server.address().port}`;
  fs.rmSync(PROFILE, { recursive: true, force: true });

  let { ctx, sw, ui, errors } = await launch();
  await sleep(2500); // let init finish
  const win = (await tabs(sw, { active: true }))[0].windowId;
  const ev = (fn, arg) => sw.evaluate(fn, arg);
  const newTab = (url, extra = {}) => ev(([url, extra, win]) => chrome.tabs.create({ url, windowId: win, ...extra }), [url, extra, win]);
  const activate = (id) => ev((id) => chrome.tabs.update(id, { active: true }), id);
  const remove = (id) => ev((id) => chrome.tabs.remove(id), id);
  const get = (id) => ev((id) => chrome.tabs.get(id).catch(() => null), id);
  const loaded = (id) => waitFor(async () => (await get(id))?.status === 'complete');

  // ---- 1. Pinned tab: close → reset, hibernate, MRU focus
  const home = await newTab(`${B}/home`); await loaded(home.id);
  const other = await newTab(`${B}/other`); await loaded(other.id);
  const p = await newTab(`${B}/a`, { pinned: true }); await loaded(p.id);
  await sleep(1200);
  let ov = await call(ui, 'overview');
  check('pinned tab auto-anchored', ov.anchors.some((a) => a.url === `${B}/a` && a.kind === 'pinned'));
  await ev(([id, u]) => chrome.tabs.update(id, { url: u }), [p.id, `${B}/b`]); await sleep(800);
  await activate(home.id); await sleep(150);
  await activate(other.id); await sleep(150);
  await activate(home.id); await sleep(150); // MRU: home > other
  await activate(p.id); await sleep(300);
  await remove(p.id);
  const rec = await waitFor(async () => (await tabs(sw, { pinned: true, windowId: win })).find((t) => t.url === `${B}/a` && t.discarded));
  check('closed pinned tab recreated at anchor URL and hibernated', !!rec, rec ? `index=${rec.index}` : '');
  check('recreated in same slot', rec && rec.index === 0);
  let act = (await tabs(sw, { active: true, windowId: win }))[0];
  check('focus went to MRU loaded tab (home)', act.id === home.id, act.url);
  check('recreated tab is unmuted after hibernating', rec && !rec.mutedInfo.muted);

  // ---- 5. Edit anchor URL, close → new URL
  ov = await call(ui, 'overview');
  const pa = ov.anchors.find((a) => a.kind === 'pinned');
  check('anchor title captured from loaded page', pa.title === 'Page a', pa.title);
  await call(ui, 'setAnchorUrl', { anchorId: pa.id, url: `127.0.0.1:${server.address().port}/c` }).catch(() => {});
  await call(ui, 'setAnchorUrl', { anchorId: pa.id, url: `${B}/c` });
  let bad = await call(ui, 'setAnchorUrl', { anchorId: pa.id, url: 'javascript:alert(1)' }).then(() => null, (e) => e.message);
  check('javascript: anchor rejected', !!bad, bad || '');
  const pinNow = (await tabs(sw, { pinned: true, windowId: win }))[0];
  await activate(pinNow.id); await sleep(300); // wakes it (reloads /a)
  await remove(pinNow.id);
  const rec2 = await waitFor(async () => (await tabs(sw, { pinned: true, windowId: win })).find((t) => t.url === `${B}/c` && t.discarded));
  check('edited anchor URL used on close', !!rec2);

  // ---- 3. Grouped tabs (explicit anchoring)
  const g1 = await newTab(`${B}/g1`); const g2 = await newTab(`${B}/g2`);
  await loaded(g1.id); await loaded(g2.id);
  const gid = await ev(([a, b]) => chrome.tabs.group({ tabIds: [a, b] }), [g1.id, g2.id]);
  await ev((gid) => chrome.tabGroups.update(gid, { title: 'Work', color: 'blue' }), gid);
  await sleep(1200);
  ov = await call(ui, 'overview');
  check('grouped tabs NOT auto-anchored', !ov.anchors.some((a) => a.kind === 'group'));
  await call(ui, 'anchorTab', { tabId: g1.id });
  const g1now = await get(g1.id);
  check('anchoring grouped tab keeps it in group, unpinned', g1now.groupId === gid && !g1now.pinned);
  await sleep(800);
  await remove(g1.id);
  let rg = await waitFor(async () => (await tabs(sw, { windowId: win })).find((t) => t.url === `${B}/g1` && t.discarded));
  check('grouped anchor recreated in its group', rg && rg.groupId === gid);
  const gtabs = (await tabs(sw, { windowId: win })).filter((t) => t.groupId === gid).sort((a, b) => a.index - b.index);
  check('grouped anchor kept its position in group', gtabs[0]?.url === `${B}/g1`, gtabs.map((t) => t.url).join(','));
  await remove(g2.id); await sleep(800);
  check('un-anchored grouped tab really closes', !(await tabs(sw, {})).some((t) => t.url === `${B}/g2`));
  // Last tab in group: close → group recreated
  await activate(rg.id); await loaded(rg.id); await sleep(300);
  await remove(rg.id);
  rg = await waitFor(async () => (await tabs(sw, { windowId: win })).find((t) => t.url === `${B}/g1` && t.discarded));
  const g = rg && rg.groupId !== -1 ? await ev((id) => chrome.tabGroups.get(id), rg.groupId) : null;
  check('last tab in group: group recreated with title/color', g && g.title === 'Work' && g.color === 'blue', g ? `${g.title}/${g.color}` : 'no group');

  // ---- 7. New tab pages are never anchored
  const blank = await newTab('chrome://newtab/', { pinned: true });
  await sleep(1300);
  ov = await call(ui, 'overview');
  check('pinned new tab page is not anchored', !ov.anchors.some((a) => a.live?.tabId === blank.id));
  const blankErr = await call(ui, 'anchorTab', { tabId: blank.id }).then(() => null, (e) => e.message);
  check('anchoring a blank tab is refused', /Open a page/.test(blankErr || ''), blankErr || 'no error');
  await remove(blank.id); await sleep(500);
  check('blank pinned tab closes for real', !(await tabs(sw, {})).some((t) => t.id === blank.id || (t.pinned && t.url.startsWith('chrome://newtab'))));

  // ---- 8. Options page: Pinned / Folders sections and the ⋯ menu
  const tmp = await newTab(`${B}/tmp`, { pinned: true }); await loaded(tmp.id); await sleep(1300);
  await ui.reload(); await ui.waitForSelector('#pinned .item');
  const pinnedRows = await ui.locator('#pinned .item').count();
  const folderHeads = await ui.locator('#folders h3').allTextContents();
  const folderRows = await ui.locator('#folders .item').count();
  check('options: pinned section lists pinned anchors', pinnedRows === 2, `rows=${pinnedRows}`);
  check('options: folder section grouped under "Work"', folderHeads.length === 1 && folderHeads[0] === 'Work' && folderRows === 1, `${folderHeads} rows=${folderRows}`);
  // Edit URL through the menu
  const rowId = await ui.locator('#pinned .item', { hasText: '/c' }).first().getAttribute('data-id');
  const row = ui.locator(`#pinned .item[data-id="${rowId}"]`);
  await row.locator('.more').click();
  check('options: ⋯ opens the menu', await ui.locator('#menu').evaluate((m) => m.matches(':popover-open')));
  await ui.locator('#menu [role=menuitem]', { hasText: 'Edit URL' }).click();
  await row.locator('.edit input').fill(`${B}/c2`);
  await row.locator('.edit input').press('Enter');
  await sleep(500);
  ov = await call(ui, 'overview');
  check('options: Edit URL saves the anchor', ov.anchors.some((a) => a.url === `${B}/c2`));
  const c2 = ov.anchors.find((a) => a.url === `${B}/c2`);
  await call(ui, 'setAnchorUrl', { anchorId: c2.id, url: `${B}/c` });
  // Remove through the menu
  await ui.reload(); await ui.waitForSelector('#pinned .item');
  await ui.locator('#pinned .item', { hasText: '/tmp' }).locator('.more').click();
  await ui.locator('#menu [role=menuitem]', { hasText: 'Remove anchor' }).click();
  await sleep(500);
  ov = await call(ui, 'overview');
  check('options: Remove anchor removes it', !ov.anchors.some((a) => a.url === `${B}/tmp`));
  check('options: list re-rendered without it', (await ui.locator('#pinned .item').count()) === 1);
  await remove(tmp.id); await sleep(800);
  check('un-anchored pinned tab closes for real', !(await tabs(sw, {})).some((t) => t.url === `${B}/tmp`));

  // ---- 4. Closing a normal tab must not land on a hibernated tab
  // Close every unpinned, ungrouped tab except one fresh tab, which we then close.
  for (const t of await tabs(sw, { windowId: win })) {
    if (!t.pinned && t.groupId === -1 && !t.url.startsWith('chrome-extension')) await remove(t.id);
  }
  await sleep(800);
  const lone = await newTab(`${B}/lone`, { active: true }); await loaded(lone.id);
  // Move the extension page away so only hibernated tabs + lone remain as candidates
  await ui.close();
  await sleep(500);
  const before = await tabs(sw, { windowId: win });
  console.log('      tabs before:', before.map((t) => `${t.url.replace(B, '')}${t.pinned ? '[P]' : ''}${t.discarded ? '[zz]' : ''}${t.active ? '*' : ''}`).join(' '));
  await remove(lone.id);
  await sleep(1500);
  const after = await tabs(sw, { windowId: win });
  console.log('      tabs after: ', after.map((t) => `${t.url.replace(B, '') || t.pendingUrl}${t.pinned ? '[P]' : ''}${t.discarded ? '[zz]' : ''}${t.active ? '*' : ''}`).join(' '));
  act = after.find((t) => t.active);
  check('no loaded tab left → new tab opened and focused', act && !act.pinned && act.groupId === -1, act?.url || act?.pendingUrl);
  check('hibernated tabs stayed hibernated', after.filter((t) => t.pinned || t.groupId !== -1).every((t) => t.discarded));

  // ---- 2. Close active anchored tab when everything else is hibernated
  const pin = after.find((t) => t.pinned);
  await activate(pin.id); await loaded(pin.id); await sleep(300);
  for (const t of await tabs(sw, { windowId: win })) if (!t.pinned && t.groupId === -1) await remove(t.id);
  await sleep(500);
  await remove(pin.id);
  await sleep(1500);
  const after2 = await tabs(sw, { windowId: win });
  act = after2.find((t) => t.active);
  check('closing anchored tab with only hibernated tabs left → new tab', act && !act.pinned && act.groupId === -1, act?.url || act?.pendingUrl);

  // ---- 6a. Restart with session restore → drifted anchor reset
  const pinned = await waitFor(async () => (await tabs(sw, { pinned: true })).find((t) => t.discarded));
  await activate(pinned.id); await loaded(pinned.id);
  await ev(([id, u]) => chrome.tabs.update(id, { url: u }), [pinned.id, `${B}/drifted`]);
  await waitFor(async () => (await get(pinned.id))?.url === `${B}/drifted`);
  await sleep(1500);
  await ctx.close();

  ({ ctx, sw, ui, errors } = await launch(['--restore-last-session']));
  const resetOk = await waitFor(async () => (await tabs(sw, { pinned: true })).some((t) => t.url === `${B}/c`), 20000);
  let all = await tabs(sw, {});
  console.log('      after restart:', all.map((t) => `${t.url.replace(B, '')}${t.pinned ? '[P]' : ''}${t.groupId !== -1 ? '[G]' : ''}`).join(' '));
  check('restart: pinned anchor reset to anchor URL', !!resetOk);
  check('restart: no duplicate pinned anchors', (await tabs(sw, { pinned: true })).length === 1);
  check('restart: grouped anchor present once', all.filter((t) => t.url === `${B}/g1`).length === 1);
  await ctx.close();

  // ---- 6b. Restart without session restore → anchors recreated
  ({ ctx, sw, ui, errors } = await launch());
  const recreated = await waitFor(async () => {
    const t = await tabs(sw, {});
    return t.some((x) => x.pinned && x.url === `${B}/c`) && t.some((x) => x.url === `${B}/g1` && x.groupId !== -1);
  }, 20000);
  all = await tabs(sw, {});
  console.log('      fresh start:  ', all.map((t) => `${t.url.replace(B, '')}${t.pinned ? '[P]' : ''}${t.groupId !== -1 ? '[G]' : ''}`).join(' '));
  check('fresh start: missing anchors recreated', !!recreated);
  check('options page: no JS errors', errors.length === 0, errors.join('; '));
  await ctx.close();

  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
