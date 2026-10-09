# Tabs

Each browser publishes its open http(s) tabs, encrypted. The popup's "Other devices" view lists each other device's windows and tabs, and any device can be sent a tab, which opens there immediately when it's online.

## Sub-features

- `other-devices`: the popup lists each other device (heading = device name, "seen …") with "Window N · M tabs" and rows that open the tab here.
- `open-all`: the "Open all" link opens every tab of a window.
- `send-popup`: the "Send this tab" button next to a device sends the active tab of the popup's window. The button turns into "Sent ✓".
- `send-menu`: right-click a page or link → "Send to device" → device name.
- `share-toggle`: "This browser" → "Share this browser's open tabs with my other devices" checkbox. Unchecking it hides this browser's tabs elsewhere.

## How to get to it (user POV)

- Click the toolbar icon. The popup opens on "Other devices".
- Right-click any web page or link.
- Open the options page → This browser.

## Driving it with verify.sh

Preconditions:

- A has an account and B is paired.

- **Publish.** On B, open `context.newPage()` and go to `${server.url}/healthz?on=b`, then run `b.call("syncNow")`.
- **See it.** Run `const pop = await popup(a)` and wait for `getByRole("heading", { name: "Chromium B" })` and `.item` with text `localhost`. The first `.item`'s `title` attribute is the full URL.
- **Send from the popup.** On A, open the page to send and call `bringToFront()` on it. Arm `b.context.waitForEvent("page", { predicate: p => p.url() === url })`. Then in the popup, click `locator("section", { has: heading "Chromium B" }).getByRole("button", { name: "Send this tab" })` and wait for the "Sent ✓" button. B's new page resolves.
- **Proof.** `../scenarios/tabs.ts` produces two PASS lines plus `1-a-popup-other-devices.png` and `2-a-popup-sent.png`.

## Gotchas

- Only `http(s)` tabs in non-incognito windows are shared. `chrome-extension://` pages, including the options page itself, never show up.
- The popup opened as a page is itself a tab. Without `bringToFront()` on the target page, "Send this tab" sends the popup's own URL.
- `send-menu` is unreachable here: headless Chromium has no right-click menus. Report it as unverified. `call("sendTab", …)` exercises the same background handler but doesn't prove the menu.
- The popup loads devices once when it opens. Reopen it (or `reload()`) after the other device publishes.
