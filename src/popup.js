import { send } from './shared.js';

const $ = (id) => document.getElementById(id);
let tabId = null;
let anchor = null;

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

async function run(fn, okText) {
  try {
    await fn();
    if (okText) setStatus(okText);
    await render();
  } catch (e) {
    setStatus(e.message, true);
  }
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;
  const info = await send('tabInfo', { tabId });
  anchor = info.anchor;
  $('current').textContent = info.tab.url;
  $('current').title = info.tab.url;

  $('anchored').hidden = !anchor;
  $('notAnchored').hidden = !!anchor;
  $('badge').classList.toggle('on', !!anchor);

  if (anchor) {
    $('badge').textContent = anchor.kind === 'group' ? 'Anchored · folder' : 'Anchored · tab';
    if (document.activeElement !== $('url')) $('url').value = anchor.url;
  } else {
    $('badge').textContent = 'Not anchored';
    const canAnchor = !info.tab.pinned;
    $('notAnchoredText').textContent = !canAnchor
      ? 'Helium resets and unloads pinned tabs on close by itself, so they aren’t anchored here.'
      : info.tab.grouped
        ? 'This tab is in a folder. Anchoring keeps it there and uses the current page as its anchor URL.'
        : 'Anchoring keeps this tab where it is and uses the current page as its anchor URL.';
    $('anchor').hidden = !canAnchor;
  }
}

$('save').onclick = () => run(() => send('setAnchorUrl', { anchorId: anchor.id, url: $('url').value }), 'Anchor URL saved');
$('url').onkeydown = (e) => e.key === 'Enter' && $('save').click();
$('useCurrent').onclick = () =>
  run(async () => {
    const a = await send('setAnchorUrlFromTab', { tabId });
    $('url').value = a.url;
  }, 'Anchor URL set to this page');
$('reset').onclick = () => run(() => send('resetTab', { tabId }), 'Back at anchor URL');
$('hibernate').onclick = () => chrome.tabs.remove(tabId).then(() => window.close());
$('unanchor').onclick = () => run(() => send('unanchor', { anchorId: anchor.id }), 'Anchor removed');
$('closeForReal').onclick = () =>
  send('closeAndUnanchor', { tabId }).then(() => window.close(), (e) => setStatus(e.message, true));
$('anchor').onclick = () => run(() => send('anchorTab', { tabId }), 'Tab anchored');
$('options').onclick = (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
};

render().catch((e) => setStatus(e.message, true));
