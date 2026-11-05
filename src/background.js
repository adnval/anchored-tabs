// Anchored Tabs — service worker.
//
// An "anchor" is a remembered (URL, slot) pair attached to a pinned tab or a
// tab inside a tab group. Closing an anchored tab doesn't really close it: the
// tab is recreated in the same slot at its anchor URL, hibernated (discarded),
// and focus moves to a loaded tab instead.
//
// Chromium gives extensions no way to intercept Ctrl+W / the close button, so
// "close → reset" is implemented as "tab removed → recreate it". The tab's
// back/forward history is lost (it would be reset anyway) and its tab id
// changes; everything else is handled here.

import { DEFAULT_SETTINGS, isBlankUrl, normalizeUrl } from './shared.js';

const WAKE_GRACE_MS = 2000; // a tab woken this recently still counts as hibernated
const HIBERNATE_TIMEOUT_MS = 15000; // max time to let a page load before discarding
const HIBERNATE_CONCURRENCY = 3;
const STARTUP_SETTLE_MS = 1200; // tab count must be stable this long after startup
const STARTUP_MAX_WAIT_MS = 10000;
const MEMBERSHIP_DELAY_MS = 600; // let pin/group changes settle before acting
const SNAPSHOT_DELAY_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.debug('[anchored-tabs]', ...args);

// ---------------------------------------------------------------------------
// State
//
// storage.local   anchors, settings                 (survive restarts)
// storage.session tabMap, active, seen, sleeping…   (cleared on browser restart)
// ---------------------------------------------------------------------------

let cache = null;
let extensionUpdated = false; // extension updated/reloaded → not a browser restart
const hibernating = new Set(); // tab ids loading in the background before discard

async function getState() {
  if (cache) return cache;
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['anchors', 'settings']),
    chrome.storage.session.get(['tabMap', 'active', 'prevActive', 'seen', 'sleeping', 'initialized']),
  ]);
  cache = {
    anchors: local.anchors || {},
    settings: { ...DEFAULT_SETTINGS, ...(local.settings || {}) },
    tabMap: session.tabMap || {}, // tabId -> anchorId
    active: session.active || {}, // windowId -> { tabId, at }
    prevActive: session.prevActive || {}, // windowId -> { tabId, at } (the tab that lost focus)
    seen: session.seen || {}, // tabId -> { at, prevAt } activation times, for MRU
    sleeping: session.sleeping || {}, // tabId -> 0 (asleep) | wokeAt timestamp
    initialized: !!session.initialized,
  };
  return cache;
}

async function persistLocal() {
  const s = await getState();
  await chrome.storage.local.set({ anchors: s.anchors, settings: s.settings });
}

let localTimer = null;
function persistLocalSoon() {
  clearTimeout(localTimer);
  localTimer = setTimeout(() => persistLocal().catch(log), 500);
}

async function persistSession() {
  const s = await getState();
  const { tabMap, active, prevActive, seen, sleeping, initialized } = s;
  await chrome.storage.session.set({ tabMap, active, prevActive, seen, sleeping, initialized });
}

// Every state-changing operation runs through this queue, so events that
// arrive together (close + activate + create) are handled in order.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(() => fn());
  chain = run.catch((e) => log('task failed', e));
  return run;
}

const tabUrl = (t) => t.url || t.pendingUrl || '';
const anchorIdFor = (s, tabId) => s.tabMap[String(tabId)];

function isSleeping(s, tabId) {
  if (hibernating.has(tabId)) return true;
  const v = s.sleeping[String(tabId)];
  return v !== undefined && (v === 0 || Date.now() - v < WAKE_GRACE_MS);
}

function liveTabIdFor(s, anchorId) {
  for (const [tabId, id] of Object.entries(s.tabMap)) if (id === anchorId) return Number(tabId);
  return null;
}

// ---------------------------------------------------------------------------
// Startup / reconciliation
// ---------------------------------------------------------------------------

let initPromise = null;

/** Make sure tab ids are mapped to anchors. Runs once per browser session. */
function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      const s = await getState();
      if (s.initialized) return;
      await waitForTabsToSettle();
      // Session storage is empty both after a browser restart and after the
      // extension is updated/reloaded. Only reset URLs on a restart. (A fresh
      // install has no anchors yet, so treating it as a restart is harmless;
      // Helium updates fire onInstalled with reason "chrome_update" and *are*
      // restarts.)
      const restart = !extensionUpdated;
      await reconcile({
        reset: restart && s.settings.resetOnStartup,
        recreateMissing: restart && s.settings.recreateMissingOnStartup,
      });
    })().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

async function waitForTabsToSettle() {
  const start = Date.now();
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() - start < STARTUP_MAX_WAIT_MS) {
    const count = (await chrome.tabs.query({})).length;
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (count > 0 && Date.now() - stableSince >= STARTUP_SETTLE_MS) {
      return;
    }
    await sleep(250);
  }
}

function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/**
 * Match the tabs that exist right now to stored anchors. Tab ids change on
 * every restart, so this uses the URL first, then the host, then position.
 */
async function reconcile({ reset, recreateMissing }) {
  const s = await getState();
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowType: 'normal' }),
    chrome.tabGroups.query({}),
  ]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const now = Date.now();

  s.tabMap = {};
  s.sleeping = {};
  s.seen = {};
  s.active = {};
  s.prevActive = {};
  for (const t of tabs) {
    if (t.discarded || t.status === 'unloaded') s.sleeping[t.id] = 0;
    if (t.active) {
      s.active[t.windowId] = { tabId: t.id, at: now };
      s.seen[t.id] = { at: now, prevAt: 0 };
    }
  }

  const candidates = tabs
    .filter((t) => !t.incognito && (t.pinned || t.groupId !== -1))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const remaining = new Set(Object.keys(s.anchors));
  const matched = new Map(); // tabId -> anchor

  const kindMatches = (a, t) => (a.kind === 'pinned' ? t.pinned : !t.pinned && t.groupId !== -1);
  const groupMatches = (a, t) => {
    if (a.kind !== 'group' || !a.pos?.groupTitle) return true;
    return groupById.get(t.groupId)?.title === a.pos.groupTitle;
  };
  const pass = (pred) => {
    const ordered = [...remaining]
      .map((id) => s.anchors[id])
      .sort((x, y) => (x.pos?.index ?? 0) - (y.pos?.index ?? 0));
    for (const t of candidates) {
      if (matched.has(t.id)) continue;
      const a = ordered.find((a) => remaining.has(a.id) && kindMatches(a, t) && pred(a, t));
      if (a) {
        matched.set(t.id, a);
        remaining.delete(a.id);
      }
    }
  };
  pass((a, t) => groupMatches(a, t) && tabUrl(t) === a.url);
  pass((a, t) => groupMatches(a, t) && sameHost(tabUrl(t), a.url));
  // Same slot: pinned tabs by order; grouped tabs by position inside the group.
  const groupStart = new Map();
  for (const t of tabs) {
    if (t.groupId !== -1) groupStart.set(t.groupId, Math.min(groupStart.get(t.groupId) ?? Infinity, t.index));
  }
  pass(
    (a, t) =>
      a.kind === 'pinned' ||
      (groupMatches(a, t) && (a.pos?.groupOffset ?? -1) === t.index - groupStart.get(t.groupId)),
  );
  if (s.settings.autoAnchorGrouped) pass(() => true); // group renamed: by position only

  const toReset = [];
  for (const t of candidates) {
    const a = matched.get(t.id);
    if (a) {
      s.tabMap[t.id] = a.id;
      if (reset && a.url && tabUrl(t) !== a.url) toReset.push([t, a]);
    } else if ((t.pinned ? s.settings.autoAnchorPinned : s.settings.autoAnchorGrouped) && !isBlankUrl(tabUrl(t))) {
      createAnchor(s, t);
    }
  }

  const toHibernate = [];
  if (recreateMissing && remaining.size) {
    const win =
      (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)) ||
      (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0];
    if (win) {
      const missing = [...remaining]
        .map((id) => s.anchors[id])
        .filter((a) => a.url)
        .sort(
          (x, y) =>
            (x.kind === y.kind ? 0 : x.kind === 'pinned' ? -1 : 1) || (x.pos?.index ?? 0) - (y.pos?.index ?? 0),
        );
      for (const a of missing) {
        try {
          toHibernate.push(await recreate(s, a, win.id));
        } catch (e) {
          log('could not recreate anchor', a.url, e);
        }
      }
    }
  }

  s.initialized = true;
  await Promise.all([persistLocal(), persistSession()]);
  scheduleSnapshot();

  for (const [t, a] of toReset) {
    if (!t.active) hibernating.add(t.id);
    chrome.tabs
      .update(t.id, { url: a.url })
      .then(() => {
        if (!t.active) hibernateWhenLoaded(t.id);
      })
      .catch((e) => {
        hibernating.delete(t.id);
        log(e);
      });
  }
  toHibernate.forEach((id) => hibernateWhenLoaded(id));
  log('reconciled', { matched: matched.size, missing: remaining.size, reset: toReset.length });
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/** Callers make sure `url` is a real page (not the new tab page). */
function createAnchor(s, tab, url = tabUrl(tab)) {
  const anchor = {
    id: crypto.randomUUID(),
    kind: tab.pinned ? 'pinned' : 'group',
    url,
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    pos: { index: tab.index },
    createdAt: Date.now(),
  };
  s.anchors[anchor.id] = anchor;
  s.tabMap[tab.id] = anchor.id;
  scheduleSnapshot();
  return anchor;
}

function removeAnchor(s, anchorId) {
  delete s.anchors[anchorId];
  for (const [tabId, id] of Object.entries(s.tabMap)) if (id === anchorId) delete s.tabMap[tabId];
}

async function findGroup(windowId, pos) {
  if (pos.groupId != null) {
    const g = await chrome.tabGroups.get(pos.groupId).catch(() => null);
    if (g && g.windowId === windowId) return g.id;
  }
  if (!pos.groupTitle) return null;
  const groups = await chrome.tabGroups.query({ windowId });
  const g =
    groups.find((g) => g.title === pos.groupTitle && g.color === pos.groupColor) ||
    groups.find((g) => g.title === pos.groupTitle);
  return g ? g.id : null;
}

/** Open a fresh tab for `anchor` in its old slot. Returns the new tab id. */
async function recreate(s, anchor, windowId) {
  const pos = anchor.pos || {};
  let tab;
  if (anchor.kind === 'pinned') {
    tab = await chrome.tabs.create({ windowId, url: anchor.url, pinned: true, active: false, index: pos.index ?? 0 });
    register(s, tab.id, anchor.id);
  } else {
    const groupId = await findGroup(windowId, pos);
    const tabs = await chrome.tabs.query({ windowId });
    let index = Math.min(pos.index ?? tabs.length, tabs.length);
    if (groupId != null) {
      const members = tabs.filter((t) => t.groupId === groupId);
      const first = Math.min(...members.map((t) => t.index));
      index = first + Math.min(pos.groupOffset ?? members.length, members.length);
    }
    tab = await chrome.tabs.create({ windowId, url: anchor.url, active: false, index });
    register(s, tab.id, anchor.id);
    try {
      if (groupId != null) {
        await chrome.tabs.group({ groupId, tabIds: [tab.id] });
      } else {
        // The closed tab was the last one in its group, so the group is gone.
        const gid = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
        await chrome.tabGroups
          .update(gid, { title: pos.groupTitle || '', color: pos.groupColor || 'grey', collapsed: !!pos.groupCollapsed })
          .catch(log);
      }
    } catch (e) {
      // Couldn't put it back in a folder: drop the stray tab. The anchor stays
      // and can be reopened from the options page.
      delete s.tabMap[tab.id];
      delete s.sleeping[tab.id];
      hibernating.delete(tab.id);
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw e;
    }
  }
  scheduleSnapshot();
  return tab.id;
}

function register(s, tabId, anchorId) {
  s.tabMap[tabId] = anchorId;
  s.sleeping[tabId] = 0;
  hibernating.add(tabId);
}

// ---------------------------------------------------------------------------
// Hibernation
// ---------------------------------------------------------------------------

let slots = HIBERNATE_CONCURRENCY;
const waiters = [];
async function acquire() {
  if (slots > 0) return void slots--;
  await new Promise((r) => waiters.push(r));
}
function release() {
  const next = waiters.shift();
  if (next) next();
  else slots++;
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info, tab) => {
      if (id === tabId && info.status === 'complete' && !isBlankUrl(tab.url)) finish();
    };
    const onRemoved = (id) => id === tabId && finish();
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete' && !isBlankUrl(t.url)) finish();
    }, finish);
  });
}

/**
 * Let a background tab load (so it gets a real title and favicon), then
 * discard it. Skipped if the user switches to the tab in the meantime.
 */
async function hibernateWhenLoaded(tabId) {
  hibernating.add(tabId);
  await acquire();
  let mutedByUs = false;
  let finalId = tabId;
  try {
    const s = await getState();
    const t0 = await chrome.tabs.get(tabId);
    if (s.settings.muteWhileHibernating && !t0.mutedInfo?.muted) {
      await chrome.tabs.update(tabId, { muted: true });
      mutedByUs = true;
    }
    await waitForComplete(tabId, HIBERNATE_TIMEOUT_MS);
    await sleep(400); // favicons often arrive just after "complete"
    const t = await chrome.tabs.get(tabId);
    if (!t.active && !t.discarded) {
      await serial(() => updateAnchorMeta(s, t));
      const d = await chrome.tabs.discard(tabId);
      if (d && d.id !== tabId) {
        finalId = d.id;
        await serial(() => remapTab(s, tabId, d.id));
      }
      await serial(async () => {
        s.sleeping[finalId] = 0;
        await persistSession();
      });
    }
  } catch (e) {
    log('hibernate skipped', tabId, e?.message);
  } finally {
    if (mutedByUs) await chrome.tabs.update(finalId, { muted: false }).catch(() => {});
    hibernating.delete(tabId);
    release();
  }
}

function updateAnchorMeta(s, tab) {
  const a = s.anchors[anchorIdFor(s, tab.id)];
  if (!a || tabUrl(tab) !== a.url) return;
  if ((tab.title && tab.title !== a.title) || (tab.favIconUrl && tab.favIconUrl !== a.favIconUrl)) {
    a.title = tab.title || a.title;
    a.favIconUrl = tab.favIconUrl || a.favIconUrl;
    persistLocalSoon();
  }
}

async function remapTab(s, oldId, newId) {
  const a = s.tabMap[oldId];
  if (a !== undefined) {
    s.tabMap[newId] = a;
    delete s.tabMap[oldId];
  }
  for (const map of [s.sleeping, s.seen]) {
    if (oldId in map) {
      map[newId] = map[oldId];
      delete map[oldId];
    }
  }
  for (const w of Object.values(s.active)) if (w.tabId === oldId) w.tabId = newId;
  await persistSession();
}

// ---------------------------------------------------------------------------
// Focus after close
// ---------------------------------------------------------------------------

/**
 * The browser has already picked a new active tab by the time onRemoved fires.
 * If it picked a hibernated tab (which now starts reloading), or the user
 * wants MRU behavior, switch to the most recently used *loaded* tab instead,
 * or open a new tab if there isn't one, and put the woken tab back to sleep.
 */
async function fixActivation(s, { windowId, removedId, newTabId, anchored, closedAt }) {
  let active = null;
  for (let i = 0; i < 15 && !active; i++) {
    const [t] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (t && t.id !== removedId) active = t;
    else await sleep(20);
  }
  if (!active) return;

  const activeAsleep = active.discarded || isSleeping(s, active.id);
  const wantMru = anchored && s.settings.afterClose === 'mru';
  if (!activeAsleep && !wantMru) return;

  // The tab the browser just activated has a fresh timestamp; rank it by
  // when it was used *before* this close instead.
  const rank = (t) => {
    const r = s.seen[t.id];
    if (!r) return t.id === active.id ? 0 : t.lastAccessed || 0;
    return r.at >= closedAt - 250 ? r.prevAt : r.at;
  };
  const tabs = await chrome.tabs.query({ windowId });
  const candidates = tabs
    .filter(
      (t) =>
        t.id !== removedId &&
        t.id !== newTabId &&
        !t.discarded &&
        t.status !== 'unloaded' &&
        !(t.id === active.id ? activeAsleep : isSleeping(s, t.id)),
    )
    .sort((a, b) => rank(b) - rank(a));
  const target = candidates[0];

  if (target) {
    if (target.id !== active.id) await chrome.tabs.update(target.id, { active: true });
  } else {
    await chrome.tabs.create({ windowId, active: true });
  }

  if (activeAsleep && target?.id !== active.id) {
    await chrome.tabs.discard(active.id).catch(() => {});
    s.sleeping[active.id] = 0;
  }
}

// ---------------------------------------------------------------------------
// Snapshots: remember each anchor's slot so it can be recreated in place
// ---------------------------------------------------------------------------

let snapshotTimer = null;
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => serial(snapshot).catch(log), SNAPSHOT_DELAY_MS);
}

async function snapshot() {
  const s = await getState();
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupStart = new Map();
  for (const t of tabs) {
    if (t.groupId !== -1) groupStart.set(t.groupId, Math.min(groupStart.get(t.groupId) ?? Infinity, t.index));
  }
  let changed = false;
  for (const t of tabs) {
    const a = s.anchors[anchorIdFor(s, t.id)];
    if (!a) continue;
    const g = groupById.get(t.groupId);
    const pos = { index: t.index };
    if (g) {
      Object.assign(pos, {
        groupId: g.id,
        groupTitle: g.title || '',
        groupColor: g.color,
        groupCollapsed: g.collapsed,
        groupOffset: t.index - groupStart.get(g.id),
      });
    } else if (a.kind === 'group' && a.pos) {
      // Mid-move: keep the group we last knew about.
      const { groupId, groupTitle, groupColor, groupCollapsed, groupOffset } = a.pos;
      Object.assign(pos, { groupId, groupTitle, groupColor, groupCollapsed, groupOffset });
    }
    if (JSON.stringify(pos) !== JSON.stringify(a.pos)) {
      a.pos = pos;
      changed = true;
    }
  }
  if (changed) await persistLocal();
}

// ---------------------------------------------------------------------------
// Membership: pinning / unpinning / grouping / ungrouping
// ---------------------------------------------------------------------------

const membershipTimers = new Map();
function scheduleMembershipCheck(tabId) {
  clearTimeout(membershipTimers.get(tabId));
  membershipTimers.set(
    tabId,
    setTimeout(() => {
      membershipTimers.delete(tabId);
      serial(() => checkMembership(tabId)).catch(log);
    }, MEMBERSHIP_DELAY_MS),
  );
}

async function checkMembership(tabId) {
  await ensureInit();
  const s = await getState();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.incognito) return;
  const anchorId = anchorIdFor(s, tabId);
  const anchor = anchorId && s.anchors[anchorId];
  const inGroup = !tab.pinned && tab.groupId !== -1;

  if (anchor) {
    if (tab.pinned) anchor.kind = 'pinned';
    else if (inGroup) anchor.kind = 'group';
    else removeAnchor(s, anchorId); // unpinned / ungrouped → a normal tab again
  } else if (
    (tab.pinned ? s.settings.autoAnchorPinned : inGroup && s.settings.autoAnchorGrouped) &&
    !isBlankUrl(tabUrl(tab)) // a pinned new tab page isn't anchored
  ) {
    createAnchor(s, tab);
  } else {
    return;
  }
  scheduleSnapshot();
  await Promise.all([persistLocal(), persistSession()]);
}

// ---------------------------------------------------------------------------
// Tab events
// ---------------------------------------------------------------------------

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.pinned || tab.groupId !== -1) scheduleMembershipCheck(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  const closedAt = Date.now();
  serial(async () => {
    await ensureInit();
    const s = await getState();
    const key = String(tabId);
    const anchorId = s.tabMap[key];
    const anchor = anchorId && s.anchors[anchorId];
    const cur = s.active[info.windowId];
    const prev = s.prevActive[info.windowId];
    const wasActive = cur?.tabId === tabId || (prev?.tabId === tabId && closedAt - prev.at < 1500);

    delete s.tabMap[key];
    delete s.sleeping[key];
    delete s.seen[key];
    hibernating.delete(tabId);

    // Closing a whole window (or quitting) keeps anchors; they're matched
    // back up on the next start.
    if (info.isWindowClosing) return persistSession();

    let newTabId = null;
    if (anchor) {
      newTabId = await recreate(s, anchor, info.windowId).catch((e) => log('recreate failed', e));
    }
    if (wasActive && (anchor || s.settings.guardAllCloses)) {
      await fixActivation(s, {
        windowId: info.windowId,
        removedId: tabId,
        newTabId,
        anchored: !!anchor,
        closedAt,
      }).catch(log);
    }
    await persistSession();
    if (newTabId) hibernateWhenLoaded(newTabId);
  });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const now = Date.now();
  serial(async () => {
    const s = await getState();
    const cur = s.active[windowId];
    if (cur && cur.tabId !== tabId) s.prevActive[windowId] = { tabId: cur.tabId, at: now };
    s.active[windowId] = { tabId, at: now };
    s.seen[tabId] = { at: now, prevAt: s.seen[tabId]?.at ?? 0 };
    if (s.sleeping[tabId] === 0) s.sleeping[tabId] = now;
    for (const [id, v] of Object.entries(s.sleeping)) if (v && now - v > WAKE_GRACE_MS) delete s.sleeping[id];
    await persistSession();
  });
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if ('pinned' in info || 'groupId' in info) scheduleMembershipCheck(tabId);
  if ('index' in info || 'groupId' in info) scheduleSnapshot();

  const tracksSleep = 'discarded' in info || info.status;
  const tracksAnchor = info.url || info.title || info.favIconUrl || info.status === 'complete';
  if (!tracksSleep && !tracksAnchor) return;

  serial(async () => {
    const s = await getState();
    const before = s.sleeping[tabId];
    if (info.discarded === true || info.status === 'unloaded') s.sleeping[tabId] = 0;
    else if ((info.discarded === false || info.status === 'loading') && before === 0) {
      s.sleeping[tabId] = Date.now();
    }
    const a = s.anchors[anchorIdFor(s, tabId)];
    if (a && tracksAnchor) updateAnchorMeta(s, tab);
    if (s.sleeping[tabId] !== before) await persistSession();
  });
});

chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  serial(async () => remapTab(await getState(), removedId, addedId));
});

chrome.windows.onRemoved.addListener((windowId) => {
  serial(async () => {
    const s = await getState();
    delete s.active[windowId];
    delete s.prevActive[windowId];
    await persistSession();
  });
});

chrome.tabs.onMoved.addListener(scheduleSnapshot);
chrome.tabs.onAttached.addListener(scheduleSnapshot);
chrome.tabs.onDetached.addListener(scheduleSnapshot);
chrome.tabGroups.onUpdated.addListener(scheduleSnapshot);

// ---------------------------------------------------------------------------
// Actions (popup, options page, context menu, keyboard shortcuts)
// ---------------------------------------------------------------------------

/** Anchor a tab. A grouped tab stays in its group; a normal tab gets pinned. */
async function anchorTab(s, tabId, url) {
  let tab = await chrome.tabs.get(tabId);
  if (isBlankUrl(url || tabUrl(tab))) throw new Error('Open a page in this tab first');
  if (!tab.pinned && tab.groupId === -1) tab = await chrome.tabs.update(tabId, { pinned: true });
  const existing = s.anchors[anchorIdFor(s, tabId)];
  if (existing) {
    if (url) existing.url = url;
    return existing;
  }
  return createAnchor(s, tab, url || tabUrl(tab));
}

async function overview(s) {
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const anchors = Object.values(s.anchors).map((a) => {
    const tabId = liveTabIdFor(s, a.id);
    const t = tabId != null ? byId.get(tabId) : null;
    return {
      ...a,
      live: t
        ? {
            tabId: t.id,
            windowId: t.windowId,
            url: tabUrl(t),
            active: t.active,
            asleep: t.discarded || t.status === 'unloaded',
          }
        : null,
    };
  });
  anchors.sort(
    (x, y) =>
      (x.live ? 0 : 1) - (y.live ? 0 : 1) ||
      (x.live?.windowId ?? 0) - (y.live?.windowId ?? 0) ||
      (x.pos?.index ?? 0) - (y.pos?.index ?? 0),
  );
  return { settings: s.settings, anchors };
}

const actions = {
  async overview(s) {
    return overview(s);
  },

  async tabInfo(s, { tabId }) {
    const tab = await chrome.tabs.get(tabId);
    const anchor = s.anchors[anchorIdFor(s, tabId)] || null;
    return {
      tab: { id: tab.id, url: tabUrl(tab), title: tab.title, pinned: tab.pinned, grouped: tab.groupId !== -1 },
      anchor,
    };
  },

  async anchorTab(s, { tabId }) {
    const a = await anchorTab(s, tabId);
    await Promise.all([persistLocal(), persistSession()]);
    return a;
  },

  async setAnchorUrl(s, { anchorId, url }) {
    const a = s.anchors[anchorId];
    if (!a) throw new Error('Anchor not found');
    a.url = normalizeUrl(url);
    await persistLocal();
    return a;
  },

  async setAnchorUrlFromTab(s, { tabId }) {
    const tab = await chrome.tabs.get(tabId);
    const url = tabUrl(tab);
    if (isBlankUrl(url)) throw new Error('This tab has no page loaded');
    const a = await anchorTab(s, tabId, url);
    a.title = tab.title || a.title;
    a.favIconUrl = tab.favIconUrl || a.favIconUrl;
    await Promise.all([persistLocal(), persistSession()]);
    return a;
  },

  async resetTab(s, { tabId }) {
    const a = s.anchors[anchorIdFor(s, tabId)];
    if (!a?.url) throw new Error('This tab is not anchored');
    await chrome.tabs.update(tabId, { url: a.url });
  },

  async unanchor(s, { anchorId }) {
    removeAnchor(s, anchorId);
    await Promise.all([persistLocal(), persistSession()]);
  },

  async closeAndUnanchor(s, { tabId }) {
    const anchorId = anchorIdFor(s, tabId);
    if (anchorId) removeAnchor(s, anchorId);
    await Promise.all([persistLocal(), persistSession()]);
    await chrome.tabs.remove(tabId); // onRemoved now sees an ordinary tab
  },

  async openAnchor(s, { anchorId, windowId }) {
    const a = s.anchors[anchorId];
    if (!a?.url) throw new Error('Anchor has no URL');
    const live = liveTabIdFor(s, anchorId);
    if (live != null) {
      const t = await chrome.tabs.update(live, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return;
    }
    const win =
      windowId != null ? { id: windowId } : await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const id = await recreate(s, a, win.id);
    await persistSession();
    hibernateWhenLoaded(id);
  },

  async saveSettings(s, { settings }) {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (k in settings && typeof settings[k] === typeof DEFAULT_SETTINGS[k]) s.settings[k] = settings[k];
    }
    if (!['mru', 'browser'].includes(s.settings.afterClose)) s.settings.afterClose = DEFAULT_SETTINGS.afterClose;
    await persistLocal();
    return s.settings;
  },

  // Read-only counters used by tests/stress.js to check nothing piles up.
  async debugStats(s) {
    const size = (o) => Object.keys(o).length;
    return {
      tabs: (await chrome.tabs.query({})).length,
      windows: (await chrome.windows.getAll()).length,
      anchors: size(s.anchors),
      tabMap: size(s.tabMap),
      seen: size(s.seen),
      sleeping: size(s.sleeping),
      active: size(s.active),
      prevActive: size(s.prevActive),
      hibernating: hibernating.size,
      waiters: waiters.length,
      freeSlots: slots,
      sessionBytes: await chrome.storage.session.getBytesInUse(),
    };
  },

  async exportData(s) {
    return { version: 1, settings: s.settings, anchors: Object.values(s.anchors) };
  },

  async importData(s, { data }) {
    if (!data || !Array.isArray(data.anchors)) throw new Error('File does not contain anchors');
    let added = 0;
    for (const raw of data.anchors) {
      if (!raw || (raw.kind !== 'pinned' && raw.kind !== 'group')) continue;
      const url = normalizeUrl(raw.url);
      const id = typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID();
      s.anchors[id] = {
        id,
        kind: raw.kind,
        url,
        title: String(raw.title || ''),
        favIconUrl: String(raw.favIconUrl || ''),
        pos: typeof raw.pos === 'object' && raw.pos ? raw.pos : {},
        createdAt: Number(raw.createdAt) || Date.now(),
      };
      added++;
    }
    if (data.settings) await actions.saveSettings(s, { settings: data.settings });
    await persistLocal();
    return { added };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = actions[msg?.type];
  if (!fn) return false;
  serial(async () => {
    await ensureInit();
    return fn(await getState(), msg);
  }).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});

const MENU = {
  'anchor-tab': 'Anchor this tab',
  'set-anchor-url': 'Set anchor URL to this page',
  'reset-to-anchor': 'Go back to anchor URL',
  'close-unanchor': 'Close tab for real (remove anchor)',
};

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title] of Object.entries(MENU)) {
      chrome.contextMenus.create({ id, title, contexts: ['page', 'action'] });
    }
  });
}

const COMMAND_ACTIONS = {
  'anchor-tab': 'anchorTab',
  'set-anchor-url': 'setAnchorUrlFromTab',
  'reset-to-anchor': 'resetTab',
  'close-unanchor': 'closeAndUnanchor',
};

async function runTabCommand(command, tab) {
  const type = COMMAND_ACTIONS[command];
  if (!type) return;
  if (!tab?.id || tab.id < 0) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  await serial(async () => {
    await ensureInit();
    return actions[type](await getState(), { tabId: tab.id });
  }).catch((e) => log(command, e.message));
}

chrome.contextMenus.onClicked.addListener((info, tab) => runTabCommand(info.menuItemId, tab));
chrome.commands.onCommand.addListener((command, tab) => runTabCommand(command, tab));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'update') extensionUpdated = true;
  setupMenus();
  serial(ensureInit).catch(log);
});

chrome.runtime.onStartup.addListener(() => {
  serial(ensureInit).catch(log);
});
