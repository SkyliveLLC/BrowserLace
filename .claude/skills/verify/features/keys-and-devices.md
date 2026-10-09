# Keys and devices

Encryption keys exist only on devices. A recovery key lets a user back in after losing every device. Removing a device rotates the account to a new key the removed device never gets. Deleting the account signs out every device.

## Sub-features

- `recovery-create`: Recovery key → "Create recovery key" shows a 13-group code once, and the user clicks "I've saved it". The button later reads "Replace recovery key".
- `recovery-use`: on a fresh browser, "Use a recovery key" → "Recover with a recovery key" → "Recover" restores everything, including data sealed after rotations.
- `remove-device`: Devices → a device row → "Remove" (with a confirm dialog) moves the account to key epoch +1.
- `delete-account`: Account → "Delete account" (a prompt where you type `DELETE`) returns this browser to "First browser". The other devices end up `revoked`.
- `plan-usage`: the Account section shows "Free plan" with Devices, Collections and Storage meters ("2 of 10").

## How to get to it (user POV)

- Open the options page → the Recovery key, Devices and Account sections.
- On a fresh browser's options page, click "Use a recovery key".

## Driving it with verify.sh

Preconditions:

- A has an account with a collection that has bookmarks, and B is paired.

- **Create a key.** On A, click "Create recovery key", read `locator(".notice .code").textContent()` (shape `^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$`), and click "I've saved it".
- **Remove a device.** Pair a third browser C. Run `a.page.reload()`, arm `a.page.once("dialog", d => void d.accept())`, click Remove on `locator("li", { hasText: "Chromium C" })`, and wait for the row to detach. `(await a.storage("config")).keyring.current` goes up by 1. B picks it up after `syncNow`. C stays on the old epoch.
- **Recover.** Launch D, click "Use a recovery key", fill the "Recover with a recovery key" card (Server, "Name for this browser", "Recovery key") and click "Recover". The collection headings appear. Mount or apply a profile, run `syncNow`, and D's `bookmarks()` equals A's.
- **Delete the account.** On the Account card (`.card` that has the "Delete account" button), arm `page.once("dialog", d => void d.accept("DELETE"))` and click it. The "First browser" heading appears. On another device, after `syncNow`, `(await storage("status")).revoked === true`.
- **Proof.** Screenshot the Devices list before and after removal, and log the epochs with `check()`.

## Gotchas

- The recovery key is shown once. Read it before clicking "I've saved it".
- A removed device keeps working locally and doesn't error immediately. Prove it by its epoch staying behind, not by a visible error on it.
- Plan limits show only because the driver's server has fake Stripe keys. Upgrade and Manage open Stripe, which this setup can't reach.
- Deleting the account ends the scenario for every browser in it, so do it last.
