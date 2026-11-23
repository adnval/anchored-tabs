// End-to-end test: loads the extension into Playwright Chromium and walks
// through close/reset/hibernate, focus, folders, URL editing and restarts.
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

  const groupOf = async (id) => (await get(id))?.groupId;
  const fmt = (list) => list.map((t) => `${(t.url || t.pendingUrl).replace(B, '')}${t.pinned ? '[P]' : ''}${t.groupId !== -1 ? '[F]' : ''}${t.discarded ? '[zz]' : ''}${t.active ? '*' : ''}`).join(' ');

  // ---- 1. Folder tab: close → reset, hibernate, MRU focus
  const home = await newTab(`${B}/home`); await loaded(home.id);
  const other = await newTab(`${B}/other`); await loaded(other.id);
  const a = await newTab(`${B}/a`); const x = await newTab(`${B}/x`);
  await loaded(a.id); await loaded(x.id);
  const gid = await ev(([a, b]) => chrome.tabs.group({ tabIds: [a, b] }), [a.id, x.id]);
  await ev((gid) => chrome.tabGroups.update(gid, { title: 'Work', color: 'blue' }), gid);
  await sleep(1200);
  let ov = await call(ui, 'overview');
  check('folder tabs are not auto-anchored', ov.anchors.length === 0);
  await call(ui, 'anchorTab', { tabId: a.id });
  const aNow = await get(a.id);
  check('anchoring keeps the tab in its folder, unpinned', aNow.groupId === gid && !aNow.pinned);
  await sleep(800);
  await ev(([id, u]) => chrome.tabs.update(id, { url: u }), [a.id, `${B}/b`]); await sleep(800);
  await activate(home.id); await sleep(150);
  await activate(other.id); await sleep(150);
  await activate(home.id); await sleep(150); // MRU: home > other
  await activate(a.id); await sleep(300);
  await remove(a.id);
  let rec = await waitFor(async () => (await tabs(sw, { windowId: win })).find((t) => t.url === `${B}/a` && t.discarded));
  check('closed folder tab recreated at anchor URL and hibernated', !!rec);
  check('recreated in its folder', rec && rec.groupId === gid);
  const members = (await tabs(sw, { windowId: win })).filter((t) => t.groupId === gid).sort((p, q) => p.index - q.index);
  check('recreated at the same position in the folder', members[0]?.url === `${B}/a`, fmt(members));
  let act = (await tabs(sw, { active: true, windowId: win }))[0];
  check('focus went to MRU loaded tab (home)', act.id === home.id, act.url);
  check('recreated tab is unmuted after hibernating', rec && !rec.mutedInfo.muted);

  // ---- 2. Edit anchor URL, close → new URL
  ov = await call(ui, 'overview');
  const fa = ov.anchors[0];
  check('anchor title captured from loaded page', fa.title === 'Page a', fa.title);
  await call(ui, 'setAnchorUrl', { anchorId: fa.id, url: `${B}/c` });
  const bad = await call(ui, 'setAnchorUrl', { anchorId: fa.id, url: 'javascript:alert(1)' }).then(() => null, (e) => e.message);
  check('javascript: anchor rejected', !!bad, bad || '');
  await activate(rec.id); await sleep(300); // wakes it (reloads /a)
  await remove(rec.id);
  rec = await waitFor(async () => (await tabs(sw, { windowId: win })).find((t) => t.url === `${B}/c` && t.discarded));
  check('edited anchor URL used on close', !!rec);

  // ---- 3. Un-anchored folder tab closes; last tab in folder recreates the folder
  await remove(x.id); await sleep(800);
  check('un-anchored folder tab really closes', !(await tabs(sw, {})).some((t) => t.url === `${B}/x`));
  await activate(rec.id); await loaded(rec.id); await sleep(300);
  await remove(rec.id);
  rec = await waitFor(async () => (await tabs(sw, { windowId: win })).find((t) => t.url === `${B}/c` && t.discarded));
  const g = rec && rec.groupId !== -1 ? await ev((id) => chrome.tabGroups.get(id), rec.groupId) : null;
  check('last tab in folder: folder recreated with title/color', g && g.title === 'Work' && g.color === 'blue', g ? `${g.title}/${g.color}` : 'no folder');
  const work = rec.groupId;

  // ---- 4. Pinned tabs are left to Helium; only real pages in folders can be anchored
  const pin = await newTab(`${B}/pin`, { pinned: true }); await loaded(pin.id); await sleep(1300);
  ov = await call(ui, 'overview');
  check('pinned tab is not anchored', ov.anchors.length === 1);
  const pinErr = await call(ui, 'anchorTab', { tabId: pin.id }).then(() => null, (e) => e.message);
  check('anchoring a pinned tab is refused', /Helium/.test(pinErr || ''), pinErr || 'no error');
  await remove(pin.id); await sleep(1000);
  check('closing a pinned tab does not recreate it', !(await tabs(sw, {})).some((t) => t.url === `${B}/pin`));

  // ---- 4b. Normal (unpinned, ungrouped) tabs can be anchored
  const loose = await newTab(`${B}/loose`); await loaded(loose.id);
  const looseIndex = (await get(loose.id)).index;
  const la = await call(ui, 'anchorTab', { tabId: loose.id });
  let looseNow = await get(loose.id);
  check('normal tab can be anchored', la.kind === 'tab' && la.url === `${B}/loose`, la.kind);
  check('…and stays unpinned and outside folders', !looseNow.pinned && looseNow.groupId === -1);
  await sleep(800);
  await ev(([id, u]) => chrome.tabs.update(id, { url: u }), [loose.id, `${B}/elsewhere`]); await sleep(800);
  await activate(home.id); await sleep(150);
  await activate(loose.id); await sleep(300);
  await remove(loose.id);
  let lrec = await waitFor(async () => (await tabs(sw, { windowId: win })).find((t) => t.url === `${B}/loose` && t.discarded));
  check('closed normal tab recreated at anchor URL and hibernated', !!lrec);
  check('…at the same position, unpinned, outside folders', lrec && lrec.index === looseIndex && !lrec.pinned && lrec.groupId === -1, lrec ? `index ${lrec.index} vs ${looseIndex}` : '');
  act = (await tabs(sw, { active: true, windowId: win }))[0];
  check('…and focus went to the MRU loaded tab', act.id === home.id, act.url);
  // Moving an anchored folder tab out of its folder keeps the anchor.
  const out = await newTab(`${B}/out`); await loaded(out.id);
  await ev(([t, g]) => chrome.tabs.group({ tabIds: [t], groupId: g }), [out.id, work]);
  await call(ui, 'anchorTab', { tabId: out.id }); await sleep(800);
  await ev((id) => chrome.tabs.ungroup(id), out.id); await sleep(1300);
  ov = await call(ui, 'overview');
  check('moving an anchored tab out of its folder keeps the anchor as a normal tab', ov.anchors.some((a) => a.url === `${B}/out` && a.kind === 'tab'));
  await call(ui, 'closeAndUnanchor', { tabId: out.id }); await sleep(800);
  check('close for real removes it for good', !(await tabs(sw, {})).some((t) => t.url === `${B}/out`) && !(await call(ui, 'overview')).anchors.some((a) => a.url === `${B}/out`));
  const blank = await newTab('chrome://newtab/');
  await ev(([t, g]) => chrome.tabs.group({ tabIds: [t], groupId: g }), [blank.id, work]); await sleep(800);
  const blankErr = await call(ui, 'anchorTab', { tabId: blank.id }).then(() => null, (e) => e.message);
  check('anchoring a blank folder tab is refused', /Open a page/.test(blankErr || ''), blankErr || 'no error');
  await remove(blank.id); await sleep(500);
  const pinMe = await newTab(`${B}/pinme`); await loaded(pinMe.id);
  await ev(([t, g]) => chrome.tabs.group({ tabIds: [t], groupId: g }), [pinMe.id, work]);
  await call(ui, 'anchorTab', { tabId: pinMe.id });
  await ev((id) => chrome.tabs.update(id, { pinned: true }), pinMe.id); await sleep(1300);
  ov = await call(ui, 'overview');
  check('pinning an anchored folder tab removes its anchor', !ov.anchors.some((a) => a.url === `${B}/pinme`));
  await remove(pinMe.id); await sleep(800);
  check('…and it then closes normally', !(await tabs(sw, {})).some((t) => t.url === `${B}/pinme`));

  // ---- 5. Options page: Folders section and the ⋯ menu
  const tmp = await newTab(`${B}/tmp`); await loaded(tmp.id);
  await ev(([t, g]) => chrome.tabs.group({ tabIds: [t], groupId: g }), [tmp.id, work]);
  await call(ui, 'anchorTab', { tabId: tmp.id }); await sleep(800);
  await ui.reload(); await ui.waitForSelector('#folders .item');
  const folderHeads = await ui.locator('#folders h3').allTextContents();
  const folderRows = await ui.locator('#folders .item').count();
  check('options: no Pinned section', (await ui.locator('#pinned').count()) === 0);
  const tabRows = await ui.locator('#tabs .item').allTextContents();
  check('options: Tabs section lists the normal-tab anchor', tabRows.length === 1 && tabRows[0].includes('/loose'), `${tabRows.length} rows`);
  check('options: anchors grouped under the "Work" folder', folderHeads.length === 1 && folderHeads[0] === 'Work' && folderRows === 2, `${folderHeads} rows=${folderRows}`);
  const rowId = await ui.locator('#folders .item', { hasText: '/c' }).first().getAttribute('data-id');
  const row = ui.locator(`#folders .item[data-id="${rowId}"]`);
  await row.locator('.more').click();
  check('options: ⋯ opens the menu', await ui.locator('#menu').evaluate((m) => m.matches(':popover-open')));
  await ui.locator('#menu [role=menuitem]', { hasText: 'Edit URL' }).click();
  await row.locator('.edit input').fill(`${B}/c2`);
  await row.locator('.edit input').press('Enter');
  await sleep(500);
  ov = await call(ui, 'overview');
  check('options: Edit URL saves the anchor', ov.anchors.some((a) => a.url === `${B}/c2`));
  await call(ui, 'setAnchorUrl', { anchorId: rowId, url: `${B}/c` });
  await ui.reload(); await ui.waitForSelector('#folders .item');
  await ui.locator('#folders .item', { hasText: '/tmp' }).locator('.more').click();
  await ui.locator('#menu [role=menuitem]', { hasText: 'Remove anchor' }).click();
  await sleep(500);
  ov = await call(ui, 'overview');
  check('options: Remove anchor removes it', !ov.anchors.some((a) => a.url === `${B}/tmp`));
  check('options: list re-rendered without it', (await ui.locator('#folders .item').count()) === 1);
  await remove(tmp.id); await sleep(800);
  check('un-anchored folder tab closes for real', !(await tabs(sw, {})).some((t) => t.url === `${B}/tmp`));

  // ---- 6. Closing a normal tab must not land on a hibernated tab
  for (const t of await tabs(sw, { windowId: win })) {
    if (t.groupId === -1 && !t.url.startsWith('chrome-extension')) await remove(t.id);
  }
  await sleep(800);
  const lone = await newTab(`${B}/lone`, { active: true }); await loaded(lone.id);
  await ui.close(); // so only hibernated tabs + lone remain as candidates
  await sleep(500);
  console.log('      tabs before:', fmt(await tabs(sw, { windowId: win })));
  await remove(lone.id);
  await sleep(1500);
  const after = await tabs(sw, { windowId: win });
  console.log('      tabs after: ', fmt(after));
  act = after.find((t) => t.active);
  check('no loaded tab left → new tab opened and focused', act && (act.url || act.pendingUrl).startsWith('chrome://newtab'), act?.url || act?.pendingUrl);
  const liveAnchorIds = new Set((await ev(async () => (await chrome.storage.session.get('tabMap')).tabMap || {}).then((m) => Object.keys(m).map(Number))));
  check('hibernated tabs stayed hibernated', after.filter((t) => liveAnchorIds.has(t.id)).length === 2 && after.filter((t) => liveAnchorIds.has(t.id)).every((t) => t.discarded));

  // ---- 7. Close the active anchored tab when everything else is hibernated
  const anchored = after.find((t) => t.groupId !== -1);
  await activate(anchored.id); await loaded(anchored.id); await sleep(300);
  for (const t of await tabs(sw, { windowId: win })) if (t.groupId === -1) await remove(t.id);
  await sleep(500);
  await remove(anchored.id);
  await sleep(1500);
  act = (await tabs(sw, { windowId: win })).find((t) => t.active);
  check('closing anchored tab with only hibernated tabs left → new tab', act && (act.url || act.pendingUrl).startsWith('chrome://newtab'), act?.url || act?.pendingUrl);

  // ---- 8a. Restart with session restore → drifted anchor reset; old pinned anchors dropped
  const fold = await waitFor(async () => (await tabs(sw, {})).find((t) => t.groupId !== -1 && t.discarded));
  await activate(fold.id); await loaded(fold.id);
  await ev(([id, u]) => chrome.tabs.update(id, { url: u }), [fold.id, `${B}/drifted`]);
  await waitFor(async () => (await get(fold.id))?.url === `${B}/drifted`);
  const looseLive = await waitFor(async () => (await tabs(sw, {})).find((t) => t.url === `${B}/loose`));
  await activate(looseLive.id); await loaded(looseLive.id);
  await ev(([id, u]) => chrome.tabs.update(id, { url: u }), [looseLive.id, `${B}/loose-drifted`]);
  await waitFor(async () => (await get(looseLive.id))?.url === `${B}/loose-drifted`);
  await sleep(1500);
  // Simulate an anchor saved by an older version for a pinned tab.
  await ev(async (u) => {
    const { anchors } = await chrome.storage.local.get('anchors');
    anchors.legacy = { id: 'legacy', kind: 'pinned', url: u, title: '', favIconUrl: '', pos: { index: 0 }, createdAt: 1 };
    await chrome.storage.local.set({ anchors, settings: { autoAnchorPinned: true } });
  }, `${B}/legacy`);
  await ctx.close();

  ({ ctx, sw, ui, errors } = await launch(['--restore-last-session']));
  const resetOk = await waitFor(async () => (await tabs(sw, {})).some((t) => t.groupId !== -1 && t.url === `${B}/c`), 20000);
  let all = await tabs(sw, {});
  console.log('      after restart:', fmt(all));
  check('restart: folder anchor reset to anchor URL', !!resetOk);
  check('restart: folder anchor present once', all.filter((t) => t.groupId !== -1).length === 1);
  const looseReset = await waitFor(async () => (await tabs(sw, {})).find((t) => t.url === `${B}/loose`), 20000);
  all = await tabs(sw, {});
  check('restart: normal-tab anchor reset, outside folders', looseReset && looseReset.groupId === -1 && !looseReset.pinned);
  check('restart: normal-tab anchor present once, nothing left drifted', all.filter((t) => t.url === `${B}/loose`).length === 1 && !all.some((t) => t.url === `${B}/loose-drifted`), fmt(all));
  ov = await call(ui, 'overview');
  check('restart: old pinned anchor dropped, not reopened', !ov.anchors.some((a) => a.kind === 'pinned') && !all.some((t) => t.url === `${B}/legacy`));
  check('restart: old pinned setting dropped', !('autoAnchorPinned' in ov.settings));
  await ctx.close();

  // ---- 8b. Restart without session restore → anchors recreated in their folder
  ({ ctx, sw, ui, errors } = await launch());
  const recreated = await waitFor(async () => {
    const t = await tabs(sw, {});
    const f = t.find((x) => x.url === `${B}/c` && x.groupId !== -1);
    return f && (await ev((id) => chrome.tabGroups.get(id), f.groupId)).title === 'Work';
  }, 20000);
  all = await tabs(sw, {});
  console.log('      fresh start:  ', fmt(all));
  check('fresh start: missing anchor recreated in its folder', !!recreated);
  check('fresh start: no pinned tabs reopened', !all.some((t) => t.pinned));
  const looseFresh = await waitFor(async () => (await tabs(sw, {})).find((t) => t.url === `${B}/loose`), 20000);
  check('fresh start: normal-tab anchor recreated outside folders', looseFresh && looseFresh.groupId === -1 && !looseFresh.pinned);
  all = await tabs(sw, {});
  check('fresh start: unrelated tabs not taken over', all.some((t) => t.url.endsWith('/src/options.html')) && all.filter((t) => t.url === `${B}/loose`).length === 1, fmt(all));
  check('options page: no JS errors', errors.length === 0, errors.join('; '));
  await ctx.close();

  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
