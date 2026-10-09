# Safety and history

Large deletions are paused until the user confirms them, and every collection keeps a change history that can be restored from. A restore applies on every device.

## Sub-features

- `delete-guard-local`: deleting many bookmarks locally shows "You deleted N bookmarks from “X”. Delete them on your other devices too?" with "Delete everywhere" and "Put them back".
- `delete-guard-remote`: incoming deletions show "Syncing “X” would remove N bookmarks from this browser." with "Remove them".
- `delete-guard-send`: on a send-only mount, the notice reads "Sending this folder would delete N bookmarks…".
- `history`: the "History" button on a collection card lists "<device> · N changes, M deleted" rows.
- `restore`: "Restore to before" (after a confirm dialog) rolls the collection back on every device.

## How to get to it (user POV)

- Notices appear at the top of the options page and in the popup.
- Collections → a collection's card → "History".

## Driving it with verify.sh

Preconditions:

- A and B are paired, and both sync `Work` with more than 10 bookmarks in a subfolder `Docs`.

- **Trip the guard.** On A, run `chrome.bookmarks.removeTree` on `Docs`, then `a.call("syncNow")` and `a.page.reload()`. Wait for `getByText(/You deleted \d+ bookmarks/)`.
- **Put back.** Click "Put them back". The notice detaches, and `a.bookmarks("Work")` has the folder again.
- **Delete everywhere.** Repeat, but click "Delete everywhere", then run `b.call("syncNow")`. B's `Docs` is gone.
- **History and restore.** On the card, click "History" and wait for the "Restore to before" button. Arm `a.page.once("dialog", d => void d.accept())` and click the row for the deletion. Then run `syncNow` on both. Both have `Docs` again.
- **Proof.** Screenshot the notice before the click and the History list after it, and `check()` both browsers' trees.

## Gotchas

- The guard fires only when a sync deletes at least `DELETE_GUARD.min` bookmarks **and** more than `DELETE_GUARD.ratio` of the folder (`packages/core/src/sync.ts`). Below that, deletes sync straight through with no notice. The e2e suite deletes 13 of 17.
- The notice only renders after the sync that detected it. Reload the options page before waiting for it.
- History rows are newest first. Choose the row by its text ("… deleted"), not by position.
