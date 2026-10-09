# Collection sync

A collection is a named set of bookmarks. Each browser chooses whether to sync it, into which folder, and in which direction. Changes reach the other open browsers within a few seconds.

## Sub-features

- `create-collection`: "New collection" with Name, "Folder in this browser" and Direction creates it and syncs it here.
- `mount`: a collection card's "Sync to a folder" → "Sync this folder" (Direction: "Two-way", "Receive only" or "Send only"). The card then reads "Syncs to …".
- `two-way`: edits on either side converge, including concurrent reorder, rename and add.
- `send-only`: the sending browser's folder is the source of truth, and edits elsewhere are reverted.
- `receive-only`: the browser takes changes but doesn't push its own.
- `live-push`: edits arrive without a manual sync, after a 2 s local debounce plus the push.
- `unmount`: "Stop syncing here" leaves the folder but stops syncing it.
- `profiles`: Profiles → "Save this browser's setup" saves the mounts, and "Apply here" on another browser recreates them.
- `popup-search`: popup → "Collections" → "Search bookmarks" finds bookmarks in every collection, including ones not synced here.

## How to get to it (user POV)

- Open the options page and go to the Collections section.
- Open the Profiles section, below Collections.
- Open the toolbar popup → "Collections". This is Safari's only way to reach collections.

## Driving it with verify.sh

Preconditions:

- A has an account and B is paired (`createAccount(a)`, `pair(a, b)`).

- **Create.** On A, fill `getByPlaceholder("Work, Research, Recipes…")` with `Work` and click the `Create` button (`exact: true`). The `Work` heading appears and A has a native `Work` folder.
- **Bookmark.** On A, `chrome.bookmarks.create` under the `Work` folder, then `a.call("syncNow")`.
- **Mount on B.** On the `Work` card, click "Sync to a folder" (optionally set `getByLabel("Direction")`), then "Sync this folder", and wait for `getByText(/Syncs to/)`. Then run `b.call("syncNow")` and check `b.bookmarks("Work")` equals `a.bookmarks("Work")`.
- **Live push.** Edit on B and poll `a.bookmarks("Work")` for up to 15 s **without** `syncNow`. Expect arrival in about 2.5 s.
- **Send-only.** Create "Reading" on A with the form's Direction set to `send` (`locator("form", { hasText: "New collection" }).getByLabel("Direction")`). Mount it on B, edit it on B, then run `syncNow` B → A → B. Both sides keep A's contents.
- **Profiles.** On B, fill `getByPlaceholder("Work laptop, Home…")`, click "Save this browser's setup" and wait for the profile's heading. On a new paired browser, click `.card` with the profile's text → "Apply here", then wait for the "Applied" button.
- **Popup search.** In `popup(a)`, click the "Collections" button, fill `getByPlaceholder("Search bookmarks")`, and read `.item .title` texts.
- **Proof.** `../scenarios/collection-sync.ts` covers create, mount, two-way and live push, with screenshots `1-a-collection-created`, `2-b-mounted` and `3-a-received-edit` and two PASS lines.

## Gotchas

- Always run `syncNow` on the receiving browser before asserting right after a mount. In the repo's own e2e run (2026-10-09), the check "B receives A's bookmarks" failed once with an empty folder straight after "Syncs to" appeared, then converged later. It passed in this skill's proof run. Treat a bare post-mount read as racy.
- Bookmarks never appear in the options page, so a screenshot doesn't prove sync. `check()` the receiving browser's `bookmarks()`.
- `chrome.bookmarks.search({ title })` matches the first folder with that title. Use unique collection names per scenario.
- "Sync this folder" with the default "New folder in Other Bookmarks" creates the folder under the collection's name.
- Profiles need at least one mount: the save button is disabled until this browser syncs something.
