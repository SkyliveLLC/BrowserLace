# BrowserLace verification map

This directory is the maintained source for verifying what BrowserLace users can do. Read this index, then use the matching feature file as the recipe. Run scenarios with `../scripts/verify.sh`; see `../SKILL.md` for the `Verify` API.

## Baseline preconditions

- `../scripts/doctor.sh` prints `READY`. In particular, the extension build is newer than its sources.
- Each run starts from nothing: a fresh server with an empty database and fresh Chromium profiles. Every recipe begins with `launch` and either `createAccount` or `pair`.
- Never point a run at `localhost:8787` (the dev server) or a hosted server. The driver always starts its own.

## Driving conventions

- Prefer ARIA roles and accessible names (`getByRole`, `getByLabel`, `getByPlaceholder`) over CSS classes. The exceptions are `.card` (a collection's or profile's box), `.code` (pairing and recovery codes) and `.item` (popup rows), because those carry no role.
- Bookmark edits go through `chrome.bookmarks.*` in `page.evaluate`, which is the same native event path as a user editing in the bookmark manager.
- Use `call("syncNow")` to skip the 1-minute alarm, but never while proving live push.

## Proof and skip reporting

- Prove the result on the *other* device, not just the one that acted.
- Pair each key step with a `check()` and a screenshot.
- If you report an entry point as unreachable, include what you tried and why it failed (for example, headless Chromium has no context menus).
- Don't report a skipped entry point as verified through a different one.

## Feature entry contract

Each feature file has an H1 and a one-paragraph description, then four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.sh`, `Gotchas`.

## Features

- [Onboarding and pairing](./onboarding-and-pairing.md): create an account, pair a browser by code or link, and rename this browser.
- [Collection sync](./collection-sync.md): create a collection, sync it into a folder in each direction, see live changes, use profiles and search in the popup. Proven by `../scenarios/collection-sync.ts`.
- [Tabs](./tabs.md): see other devices' tabs in the popup, send a tab, and stop sharing. Proven by `../scenarios/tabs.ts`.
- [Safety and history](./safety-and-history.md): the large-deletion guard and restoring a collection from history.
- [Keys and devices](./keys-and-devices.md): the recovery key, removing a device (key rotation), and deleting the account.

Not mapped yet: plan upgrades through Stripe checkout and the portal (these can't run here; see SKILL.md), and disconnecting a browser.
