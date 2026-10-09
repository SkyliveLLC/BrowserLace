# Onboarding and pairing

A new browser either creates the account, joins an existing one with a one-time pairing code or link, or recovers with a recovery key (see keys-and-devices.md). After that, the options page shows the signed-in sections.

## Sub-features

- `create-account`: the "First browser" form creates the account and lands on Collections.
- `pair-code`: the "Pair a device" button shows a code, QR and link that expire in a few minutes and work once.
- `pair-link`: pasting a `browserlace://pair?server=…&code=…` link joins with the link's server, whatever the Server field says.
- `rename-device`: "This browser" → "Device name" → Rename updates the name other devices see.

## How to get to it (user POV)

- Open the options page (popup → "Set up BrowserLace" or the Settings gear).
- First browser: fill Server and "Name for this browser", then click "Create account".
- New browser: on an existing device click Devices → "Pair a device". On the new browser, use "Add this browser" and paste the code or link, then click "Join".

## Driving it with verify.sh

Preconditions:

- Two launched browsers, `a` and `b`, with no account.

- **Create.** Run `await createAccount(a)`. The `Collections` heading appears. `(await a.storage("config")).serverUrl === server.url`.
- **Pair by code.** Run `await pair(a, b)`. B shows `Collections`. A's Devices list (after `a.page.reload()`) contains `li` rows for both names.
- **Pair by link.** On A, click "Pair a device" and read `.code`. Build ``browserlace://pair?${new URLSearchParams({ server: server.url, code })}``, then click "Done". On B, fill "Add this browser" with Server `http://wrong.invalid`, "Pairing code or link" set to the link, and click "Join". `(await b.storage("config")).serverUrl === server.url`. The e2e suite's `pairWith(..., { link: true })` in `e2e/chromium.ts` is the reference.
- **Rename.** On B, fill `getByLabel("Device name")` and click "Rename". A's popup → "Other devices" shows the new heading.
- **Proof.** Screenshot A's Devices section with both devices listed.

## Gotchas

- A pairing code works once. Create a new one for each browser you pair.
- The code input is case-insensitive. The e2e suite pastes it lowercased on purpose.
- "Copy link" uses the clipboard, which headless Chromium doesn't reliably expose. Build the link from the code instead, as above.
