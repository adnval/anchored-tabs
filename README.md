# Anchored Tabs

Zen Browser–style **Essentials** for [Helium](https://helium.computer) (and other desktop Chromium browsers).

Pinned tabs, and tabs in groups that you choose to anchor, remember an **anchor URL**. When you close one, whether with Ctrl+W, the × button or a middle-click:

1. The tab comes back in the same spot (same pinned position, or same group and position) at its anchor URL.
2. It's **hibernated** (discarded), so it uses no memory.
3. Focus moves to your most recently used *loaded* tab, never to a hibernated one. If no loaded tab is left, a new tab opens.

After a restart, anchored tabs are reset to their anchor URLs. Anchors whose tabs weren't restored are recreated, hibernated.

## Install (Helium)

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`).
4. Optional: pin the extension's toolbar button.

## Use

| What | How |
|---|---|
| Make an Essential | Pin a tab that has a page open. It's anchored automatically at its current URL. A pinned new tab page isn't anchored. |
| Anchor a tab in a group | Toolbar popup → **Anchor this tab**, or right-click the page → *Anchor this tab*. It stays in its group. |
| Change an anchor URL | Popup: edit the URL, or **Use this page**. Options page: edit any anchor. Right-click → *Set anchor URL to this page*. |
| Go back to the anchor URL without closing | Popup → **Go to anchor**, or right-click → *Go back to anchor URL*. |
| Close a tab permanently | Popup → **Close for real**, right-click → *Close tab for real*, or unpin / ungroup the tab and close it normally. |
| See and manage all anchors | Popup → *All anchors & settings*. Anchors are listed under **Pinned** and **Folders** (one heading per tab group). Each row's ⋯ menu has Edit URL, Use current page, Show/Open tab and Remove anchor. Export and import are at the bottom. |

Keyboard shortcuts are suggested as Alt+Shift+A (anchor), Alt+Shift+S (set URL to this page), Alt+Shift+R (go back to anchor) and Alt+Shift+W (close for real). The browser only assigns them if they don't clash with something else, so check or set them at `chrome://extensions/shortcuts`.

### Settings

- **Anchor every pinned tab** (on)
- **Anchor every tab inside a tab group** (off). Links opened from a grouped tab join that group automatically, so turning this on would make those link tabs impossible to close normally.
- **Never land on a hibernated tab after closing any tab** (on). Also applies to normal tabs.
- **After closing an anchored tab, focus**: the most recently used loaded tab (default), or the browser's choice unless it's hibernated.
- **Reset anchored tabs after a restart** (on)
- **Recreate anchors that weren't restored after a restart** (on)
- **Mute tabs while they load before hibernating** (on)

## How it works, and limitations

Chromium doesn't let extensions intercept Ctrl+W or stop a tab from closing. So the extension lets the tab close, then immediately recreates it at the anchor URL. The recreated tab loads briefly in the background (muted) so it gets a real title and favicon, then it's discarded. As a result:

- **Back/forward history** of a closed anchored tab is gone. It would have been reset anyway.
- **Ctrl+Shift+T** after closing an anchored tab brings back a second copy, because the anchor was already recreated.
- **The only tab in a window**: closing it closes the window. Its anchors come back on the next start.
- **Essentials are per window.** Chromium pinned tabs belong to one window, so they can't be shared across windows the way Zen does.
- **When the browser auto-focuses a hibernated tab** after a close, that tab starts reloading for a split second before the extension switches away and hibernates it again.
- **Matching after a restart** uses URL, then host, then position, because tab ids change on every restart. Heavily rearranged tabs might be matched imperfectly.

## Development

```
node tests/e2e.js
```

This needs the `playwright` package with its Chromium. The test loads the extension and covers:

- close → reset → hibernate
- most-recently-used focus
- the new-tab fallback
- grouped anchors, including recreating a group after its last tab closes
- editing anchor URLs
- restarts with and without session restore

`node tests/stress.js` closes anchored tabs, normal tabs and windows hundreds of times. It checks that the extension's bookkeeping and service-worker heap stay flat.

Playwright's Chromium build crashes on `chrome.tabs.discard`, so the test replaces that one call with a recorder.
