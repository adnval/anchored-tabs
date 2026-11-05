import { send } from './shared.js';

const $ = (id) => document.getElementById(id);
const form = $('settings');
const menu = $('menu');

let editingId = null; // anchor whose URL is being edited inline
let menuTrigger = null; // the ⋯ button that opened the menu
let renderPending = false;

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
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

function favicon(a) {
  if (a.favIconUrl && /^(https?|data):/.test(a.favIconUrl)) return a.favIconUrl;
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', a.url);
  u.searchParams.set('size', '16');
  return u.href;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return (u.host + u.pathname + u.search).replace(/\/$/, '');
  } catch {}
  return url;
}

const drifted = (a) => a.live && a.live.url && a.live.url !== a.url;

function stateOf(a) {
  if (!a.live) return ['closed', 'Not open'];
  if (a.live.active) return ['active', 'Open, active'];
  if (a.live.asleep) return ['asleep', 'Hibernated'];
  return ['loaded', 'Open, loaded'];
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function renderItem(a) {
  const li = $('itemTpl').content.firstElementChild.cloneNode(true);
  li.dataset.id = a.id;
  li.querySelector('.favicon').src = favicon(a);
  li.querySelector('.title').textContent = a.title || shortUrl(a.url);
  li.querySelector('.title').title = a.title || a.url;

  const url = li.querySelector('.url');
  url.textContent = shortUrl(a.url);
  url.title = a.url;

  const [state, label] = stateOf(a);
  const dot = li.querySelector('.dot');
  dot.classList.add(`dot-${state}`);
  const tip = drifted(a) ? `${label} · currently at ${a.live.url}` : label;
  dot.title = tip;
  dot.setAttribute('aria-label', tip);

  const more = li.querySelector('.more');
  more.setAttribute('aria-label', `Actions for ${a.title || shortUrl(a.url)}`);
  more.onclick = () => openMenu(more, a);

  if (editingId === a.id) startEdit(li, a);
  return li;
}

function startEdit(li, a) {
  editingId = a.id;
  const text = li.querySelector('.text');
  const editor = document.createElement('form');
  editor.className = 'edit';
  editor.innerHTML = `
    <input type="text" class="grow" spellcheck="false" aria-label="Anchor URL">
    <button type="submit" class="primary">Save</button>
    <button type="button" class="cancel">Cancel</button>`;
  const input = editor.querySelector('input');
  input.value = a.url;
  const stop = () => {
    editingId = null;
    render().then(() => document.querySelector(`.item[data-id="${a.id}"] .more`)?.focus());
  };
  editor.onsubmit = (e) => {
    e.preventDefault();
    send('setAnchorUrl', { anchorId: a.id, url: input.value }).then(
      () => {
        setStatus('Anchor URL saved');
        stop();
      },
      (err) => setStatus(err.message, true),
    );
  };
  editor.querySelector('.cancel').onclick = stop;
  input.onkeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      stop();
    }
  };
  li.classList.add('editing');
  text.replaceChildren(text.querySelector('.title'), editor);
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
}

// ---------------------------------------------------------------------------
// ⋯ menu
// ---------------------------------------------------------------------------

function menuItem(label, onPick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.role = 'menuitem';
  b.tabIndex = -1;
  b.textContent = label;
  b.className = cls;
  b.onclick = () => {
    menu.hidePopover();
    onPick();
  };
  return b;
}

function openMenu(trigger, a) {
  if (menu.matches(':popover-open') && menuTrigger === trigger) return menu.hidePopover();
  const items = [
    menuItem('Edit URL', () => {
      const li = document.querySelector(`.item[data-id="${a.id}"]`);
      if (li) startEdit(li, a);
    }),
  ];
  if (drifted(a)) {
    items.push(
      menuItem('Use current page', () =>
        act(() => send('setAnchorUrlFromTab', { tabId: a.live.tabId }), 'Anchor URL set to the current page'),
      ),
    );
  }
  items.push(
    menuItem(a.live ? 'Show tab' : 'Open tab', () => act(() => send('openAnchor', { anchorId: a.id }))),
    menuItem('Remove anchor', () => act(() => send('unanchor', { anchorId: a.id }), 'Anchor removed'), 'danger'),
  );
  menu.replaceChildren(...items);

  menuTrigger = trigger;
  trigger.setAttribute('aria-expanded', 'true');
  menu.showPopover();
  // Place under the button, right-aligned, flipping up if there's no room.
  const r = trigger.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const top = r.bottom + 4 + m.height > innerHeight ? r.top - 4 - m.height : r.bottom + 4;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - m.width, innerWidth - m.width - 8))}px`;
  items[0].focus();
}

menu.addEventListener('toggle', (e) => {
  if (e.newState !== 'closed') return;
  const trigger = menuTrigger;
  menuTrigger = null;
  trigger?.setAttribute('aria-expanded', 'false');
  // Return focus to the ⋯ button unless the user clicked somewhere else.
  if (trigger && (!document.activeElement || document.activeElement === document.body || menu.contains(document.activeElement))) {
    if (!editingId) trigger.focus();
  }
  if (renderPending) render();
});

menu.addEventListener('keydown', (e) => {
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  const i = items.indexOf(document.activeElement);
  const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (move) {
    e.preventDefault();
    items[(i + move + items.length) % items.length].focus();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    items[e.key === 'Home' ? 0 : items.length - 1].focus();
  } else if (e.key === 'Tab') {
    menu.hidePopover();
  }
});

addEventListener('scroll', () => menu.matches(':popover-open') && menu.hidePopover(), { passive: true });
addEventListener('resize', () => menu.matches(':popover-open') && menu.hidePopover());

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function renderFolders(anchors) {
  const folders = new Map();
  for (const a of anchors) {
    const title = a.pos?.groupTitle || '';
    const color = a.pos?.groupColor || 'grey';
    const key = `${title}\u0000${color}`;
    if (!folders.has(key)) folders.set(key, { title, color, items: [] });
    folders.get(key).items.push(a);
  }
  const ordered = [...folders.values()].sort(
    (x, y) => Math.min(...x.items.map((a) => a.pos?.index ?? 0)) - Math.min(...y.items.map((a) => a.pos?.index ?? 0)),
  );
  return ordered.map((f) => {
    const section = document.createElement('section');
    section.className = 'folder';
    const h = document.createElement('h3');
    const dot = document.createElement('span');
    dot.className = `folder-dot gc-${f.color}`;
    h.append(dot, document.createTextNode(f.title || 'Untitled folder'));
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.setAttribute('aria-label', `Folder ${f.title || 'untitled'}`);
    ul.append(...f.items.map(renderItem));
    section.append(h, ul);
    return section;
  });
}

async function render() {
  // Don't rebuild the list under an open menu or a half-typed URL.
  if (menu.matches(':popover-open') || (editingId && document.querySelector('.item.editing'))) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const { settings, anchors } = await send('overview');
  const byPos = (x, y) => (x.pos?.index ?? 0) - (y.pos?.index ?? 0);
  const pinned = anchors.filter((a) => a.kind === 'pinned').sort(byPos);
  const grouped = anchors.filter((a) => a.kind === 'group').sort(byPos);

  $('pinned').replaceChildren(...pinned.map(renderItem));
  $('pinnedEmpty').hidden = pinned.length > 0;
  $('folders').replaceChildren(...renderFolders(grouped));
  $('foldersEmpty').hidden = grouped.length > 0;

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
    setStatus(`Imported ${added} anchor(s). They'll be matched to tabs on the next restart, or use Open tab.`);
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
