// Shared helpers used by the service worker, popup and options page.

export const DEFAULT_SETTINGS = Object.freeze({
  // Every pinned tab is an anchor (Zen "Essentials").
  autoAnchorPinned: true,
  // Every tab inside a tab group is an anchor. Off by default because links
  // opened from a grouped tab join its group automatically; anchor grouped
  // tabs explicitly instead.
  autoAnchorGrouped: false,
  // After closing an anchored tab: 'mru' = jump to the most recently used
  // loaded tab; 'browser' = keep the browser's pick unless it's hibernated.
  afterClose: 'mru',
  // Also stop *any* tab close from landing you on a hibernated tab.
  guardAllCloses: true,
  // After a browser restart, send anchored tabs back to their anchor URL.
  resetOnStartup: true,
  // After a restart, recreate anchors whose tabs weren't restored.
  recreateMissingOnStartup: true,
  // Mute a tab while it loads in the background before hibernating.
  muteWhileHibernating: true,
});

const BLANK_PREFIXES = [
  'about:blank',
  'chrome://newtab',
  'chrome://new-tab-page',
  'chrome-search://',
];

/** True for URLs that mean "nothing loaded yet" (new tab page, blank). */
export function isBlankUrl(url) {
  if (!url) return true;
  return BLANK_PREFIXES.some((p) => url.startsWith(p));
}

/**
 * Turn user input into a URL the extension can open, or throw.
 * "example.com" becomes "https://example.com/".
 */
export function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('URL is empty');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol === 'javascript:') throw new Error('javascript: URLs are not allowed');
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  return url.href;
}

/** Send a message to the service worker; resolves with its result or throws. */
export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
