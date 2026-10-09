---
name: verify
description: Drive BrowserLace the way a user does to prove a change works. Runs a throwaway sync server and isolated headless Chromium profiles loaded with the built extension, drives the options page and toolbar popup with Playwright, and keeps screenshots plus a PASS/FAIL log. Use after changing the extension, the core sync engine or the server, or when asked to verify, demo or screenshot a BrowserLace feature.
---

# Verify BrowserLace

BrowserLace is a WebExtension (Chrome, Firefox, Safari) that syncs bookmark collections and open tabs through a sync server, end-to-end encrypted. A user touches two surfaces: the **options page** (`options.html`: onboarding, collections, profiles, devices, recovery key, account) and the **toolbar popup** (`popup.html`: other devices' tabs, send a tab, collection search). Almost every feature needs two or more browsers on one account, so a verification run is a small multi-device scenario.

The driver reuses the repo's e2e harness (`e2e/harness.ts`). Each run gets its own server on a random port with an empty SQLite database, plus fresh Chromium profiles. It never touches your own browsers, your dev server (`pnpm dev:server`, port 8787) or a hosted server. Runs are isolated from each other, so two can run side by side.

Read [features/README.md](features/README.md) next, then the file for the feature you're proving.

## Launch

There is no long-lived instance. A run is one scenario file that the driver executes from start to finish.

1. Build the extension after any change to `apps/extension` or `packages/core`. The driver loads `apps/extension/.output/chrome-mv3`, so a stale build proves old code. The server runs from source and needs no build.
   ```sh
   pnpm install                                   # first time only
   (cd e2e && npx playwright-core install chromium)  # first time only; system Chrome can't load unpacked extensions
   pnpm --filter @browserlace/extension build
   ```
2. Write a scenario. Copy `scenarios/collection-sync.ts` and keep scratch scenarios outside the repo (e.g. `/tmp/bl-verify-scenarios/`). A scenario imports `type { Verify }` from this skill's `scripts/drive.ts` (absolute path when it lives outside the repo) and default-exports `async (v: Verify) => {}`.
3. Run it:
   ```sh
   .claude/skills/verify/scripts/verify.sh <scenario.ts> [out-dir]
   ```
   It is ready when the server prints `{"msg":"listening",...}`. It finishes with `OK evidence in <out-dir>` (exit 0) or `FAILED evidence in <out-dir>` (exit 1). `out-dir` defaults to `/tmp/browserlace-verify/<timestamp>`. Shipped scenarios take 10–20 s.

## Doctor

Run this first, and again whenever anything looks off:

```sh
.claude/skills/verify/scripts/doctor.sh [out-dir]
```

It is read-only. It checks for Node 24+, installed e2e deps, Playwright's Chromium, and an extension build newer than every source file under `apps/extension/{entrypoints,lib,components}` and `packages/core/src`. Given an `out-dir`, it also reports whether that run's process group is still alive. It prints `READY` or `NOT READY`, plus the command that fixes each failure.

## Drive

The `Verify` object handed to a scenario (`scripts/drive.ts`):

| Member | What it does |
| --- | --- |
| `launch(name)` | Opens a fresh Chromium profile with the extension, on its options page. Returns a `Browser`. |
| `createAccount(browser)` | Fills the "First browser" form (server and name) and waits for the `Collections` heading. |
| `pair(from, to)` | Clicks "Pair a device" on `from`, reads the `.code`, and joins `to` through "Add this browser". |
| `popup(browser)` | Opens `popup.html` as a 380×580 page, which is the popup's real size. |
| `shot(page, name)` | Saves a full-page screenshot to `<out>/<name>.png`. |
| `check(label, actual, expected)` | Logs `PASS`/`FAIL` with a JSON-equality diff. Any FAIL makes the run exit 1. |
| `server.url` | The throwaway server's URL. |
| `out` | The evidence directory. |

A `Browser` has:

- `page`: a Playwright page on the options page.
- `context`: the profile. Open more tabs with `context.newPage()`.
- `id`: the extension id. Pages live at `chrome-extension://<id>/…`.
- `bookmarks(folderTitle)`: the folder's native bookmark tree as indented `Title url` lines (folders end in `/`).
- `storage(key)`: reads `chrome.storage.local`. Keys are `config`, `status`, `collections`, `mounts`.
- `call(type, input)`: sends a background message. The handlers are in `apps/extension/lib/engine.ts` (`syncNow`, `sendTab`, …).

Stable handles, all taken from `entrypoints/options/App.tsx` and `entrypoints/popup/App.tsx`:

- **Section headings:** `getByRole("heading", { name: "Collections" | "Profiles" | "Devices" | "Recovery key" | "Account" | "This browser" })`.
- **Onboarding cards:** headings "First browser", "Add this browser", "Recover with a recovery key", with labels "Server", "Name for this browser", "Pairing code or link", "Recovery key".
- **A collection's card:** `page.locator(".card", { has: page.getByRole("heading", { name, exact: true }) })`.
- **Popup:** the toggle buttons "Other devices" and "Collections", the "Search bookmarks" box, and buttons labelled "Sync now" and "Settings".

Rules:

- **User path first.** Click the real buttons and fill the real forms.
  - `chrome.bookmarks.*` inside `page.evaluate` counts as a user path. It fires the same native events as editing in the bookmark manager, which headless Chromium can't drive.
  - `call("syncNow")` is the equivalent of the popup's "Sync now" button. Use it to skip the 1-minute alarm, but never use it where you're proving live push.
  - Use other `call(...)` handlers only to set up state that isn't under test, and say so in the report.
- **Confirm dialogs** (remove device, restore, delete account) need `page.once("dialog", d => void d.accept())` before the click.
- **Wait on visible state** (`waitFor()` on a role or text), never on fixed sleeps. For cross-device arrival, poll `bookmarks()` with a deadline, as in `scenarios/collection-sync.ts`.

## Evidence

Each run leaves this in `out-dir`:

- `run.log`: every `console.log`, PASS/FAIL line and crash stack.
- `scenario.ts.txt`: the exact scenario that ran.
- Your screenshots.
- `crash-<browser>.png`: added when the scenario throws.

Proof standards:

- **Action and result.** Capture what was done and the state it produced, not just the final screen. Take a screenshot before and after the key step.
- **Side effects on the other device.** Bookmarks are invisible in the options page, so a screenshot alone proves nothing about sync. `check()` the receiving browser's `bookmarks()`, its opened tabs (`context.pages()`) or its `storage()`.
- **Every mapped entry point.** If you prove one entry point and skip another the feature map lists (e.g. the right-click "Send to device" menu), report the skipped one as unverified.
- **The mock boundary.** The server runs with fake Stripe keys so plans and limits render. Nothing calls Stripe, so checkout and the portal can't be proven here. Say so rather than faking it.

## Cleanup

```sh
.claude/skills/verify/scripts/cleanup.sh <out-dir>
```

The driver closes its browsers and stops its server on exit, Ctrl-C or SIGTERM. Run cleanup anyway after every run, and always after a failed or interrupted one. It kills only that run's process group (recorded in `<out-dir>/pgid`) and deletes `<out-dir>/scratch`, which holds the profiles and database. It keeps the evidence. Never kill browsers or `node` by process name, because the user's own Chrome and dev server match too.

## Not covered

- **Firefox.** `e2e/firefox.ts` drives Firefox ESR over WebDriver BiDi, but it launches through macOS `open -n` and won't run on Linux.
- **Safari.** It needs Xcode and a signed wrapper app, so it is manual only.
- **Real toolbar popup and context menus.** Headless Chromium can't open the toolbar popup or right-click menus. The popup is driven as a page, and the context menu can't be clicked.
