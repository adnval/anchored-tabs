import { send } from './shared.js';

const $ = (id) => document.getElementById(id);
const form = $('settings');

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function favicon(a) {
  if (a.favIconUrl && /^(https?|data):/.test(a.favIconUrl)) return a.favIconUrl;
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', a.url || 'about:blank');
  u.searchParams.set('size', '16');
  return u.href;
}

function button(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = cls;
  b.onclick = onClick;
  return b;
}

async function act(fn, okText) {
  try {
    await fn();
    if (okText) setStatus(okText);
  } catch (e) {
    setStatus(e.message, true);
  }
  await render();
}

function renderAnchor(a) {
  const el = $('anchorTpl').content.firstElementChild.cloneNode(true);
  el.querySelector('.favicon').src = favicon(a);
  el.querySelector('.title').textContent = a.title || a.url || '(waiting for first page)';
  el.querySelector('.title').title = a.title || '';

  const where = a.kind === 'pinned' ? 'Pinned' : `Group “${a.pos?.groupTitle || 'untitled'}”`;
  let state = 'Not open';
  if (a.live) state = a.live.active ? 'Open · active' : a.live.asleep ? 'Open · hibernated' : 'Open · loaded';
  const drift = a.live && a.url && a.live.url !== a.url ? ` · now at ${a.live.url}` : '';
  const meta = el.querySelector('.meta');
  meta.textContent = `${where} · ${state}${drift}`;
  meta.title = meta.textContent;

  const input = el.querySelector('.url');
  input.value = a.url;
  input.placeholder = 'Set from the first page this tab opens';
  const save = () => act(() => send('setAnchorUrl', { anchorId: a.id, url: input.value }), 'Anchor URL saved');
  el.querySelector('.save').onclick = save;
  input.onkeydown = (e) => e.key === 'Enter' && save();

  const actions = el.querySelector('.actions');
  if (a.live && a.live.url && a.live.url !== a.url) {
    actions.append(
      button('Use current page', () => act(() => send('setAnchorUrlFromTab', { tabId: a.live.tabId }), 'Anchor URL updated')),
    );
  }
  actions.append(button(a.live ? 'Show' : 'Open', () => act(() => send('openAnchor', { anchorId: a.id }))));
  actions.append(button('Remove', () => act(() => send('unanchor', { anchorId: a.id }), 'Anchor removed'), 'danger'));
  return el;
}

async function render() {
  const { settings, anchors } = await send('overview');
  const focused = document.activeElement;
  // Don't wipe a URL the user is in the middle of typing.
  if (!focused?.classList?.contains('url')) $('anchors').replaceChildren(...anchors.map(renderAnchor));
  $('empty').hidden = anchors.length > 0;

  for (const [k, v] of Object.entries(settings)) {
    const field = form.elements[k];
    if (!field) continue;
    if (field instanceof RadioNodeList) field.value = v;
    else field.checked = !!v;
  }
}

form.addEventListener('change', () => {
  const settings = {};
  for (const el of form.elements) {
    if (el.type === 'checkbox') settings[el.name] = el.checked;
    else if (el.type === 'radio' && el.checked) settings[el.name] = el.value;
  }
  act(() => send('saveSettings', { settings }), 'Settings saved');
});

$('export').onclick = async () => {
  const data = await send('exportData');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `anchored-tabs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('import').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const file = $('importFile').files[0];
  if (!file) return;
  await act(async () => {
    const { added } = await send('importData', { data: JSON.parse(await file.text()) });
    setStatus(`Imported ${added} anchor(s). They'll be matched to tabs on the next restart, or use Open.`);
  });
  $('importFile').value = '';
};

chrome.commands.getAll().then((cmds) => {
  $('commands').replaceChildren(
    ...cmds
      .filter((c) => c.description)
      .map((c) => {
        const li = document.createElement('li');
        li.textContent = `${c.description}: ${c.shortcut || 'not set'}`;
        return li;
      }),
  );
});

// Keep the list fresh while tabs change in the background.
let refreshTimer;
for (const ev of [chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onActivated]) {
  ev.addListener(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => render().catch(() => {}), 700);
  });
}

render().catch((e) => setStatus(e.message, true));
