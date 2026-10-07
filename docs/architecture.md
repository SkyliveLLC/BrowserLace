# Architecture

Three pieces: one extension codebase built for every browser, a server that only orders
and stores ciphertext, and a pure TypeScript core that holds nearly all the logic.

```
 Chrome / Firefox / Safari                         Sync server (cloud or tailnet)
┌──────────────────────────────┐   encrypted    ┌────────────────────────────────┐
│ extension (WXT)              │   changes      │ Hono + node:sqlite             │
│  background: sync engine ────┼──────────────▶ │  devices, pairings,            │
│  popup: tabs, collections    │   HTTPS        │  per-collection change log,    │
│  options: setup, collections │ ◀──────────────┤  tab snapshots (all opaque)    │
│        @browserlace/core     │                └────────────────────────────────┘
└──────────────────────────────┘
```

## Concepts

- **Account**: a group of devices sharing one 256-bit encryption key. No email or
  password; devices join by pairing.
- **Collection**: an independently synced bookmark tree with an encrypted name.
- **Mount**: per browser, a collection mapped to one native folder, either `two-way` or
  `receive`. BrowserLace only ever touches mounted folders, never the whole bookmark tree,
  and two mounts can't overlap. Receive-only mounts need a new or empty folder, because
  they replace its contents with bookmarks that were never in any history.
- **Tab snapshot**: each device's open tabs, replaced wholesale on change. Never merged.

## Data model and convergence (`packages/core/src/model.ts`)

A collection is a log of **changes**; each change is an encrypted batch of **ops**, and
every op is a field-level write to one node:

```ts
type Op = { id: string; set: Partial<{ parent; pos; title; url; deleted }> };
```

The server assigns each change a sequence number per collection, and only accepts a push
whose `head` (the last seq the client had seen) is still the end of the log. A client
that loses that race pulls, re-diffs and retries, so it can adopt what the other device
just created instead of duplicating it. Every device replays the log in order, so all
devices compute the same model with no CRDT library:

- Concurrent writes to different fields of a node both survive. For the same field, the
  later change in server order wins.
- `pos` is a fractional index key (siblings sort by `pos`, then id), so concurrent
  inserts never shift each other.
- A move that would put a folder inside itself is dropped. Every device drops the same one.
- Deletes are sticky (`deleted: true`). Edits after a delete don't revive a node, and
  children of a deleted folder are hidden.
- A change that can't be decrypted or parsed (corruption, a newer client's format) is
  skipped and reported, not retried forever. Every device skips the same one.

Because deleted nodes keep their fields, **restore** is just a diff: replay the log up to
a point, compare with the current model and push the ops that turn one into the other.
History is never rewritten, so a restore can be undone too.

## Reconciliation (`packages/core/src/reconcile.ts`, `sync.ts`)

Sync compares state, not events. Bookmark events only trigger a debounced sync. One pass:

1. **Pull** new changes and replay them into the model.
2. **Diff local**: compare the native folder with the **baseline** (the folder as it was
   after the last successful sync, in sync-id space) to find local creates, edits, moves
   and deletes. Unlinked native nodes are first **adopted** by matching unlinked model nodes
   (bookmarks by URL anywhere in the collection, preferring the same folder; folders by
   title in the same folder), so mounting a folder that already holds the bookmarks, or
   re-creating deleted ones, doesn't duplicate them. Reorders keep the longest run of
   siblings that didn't move and only re-key the rest. Appended keys get a random suffix
   so concurrent appends don't tie.
3. **Push** those ops as one change (against the current head), then pull again to get
   them back in server order.
4. **Apply**: make the native folder match the model: update and move top-down, fix
   sibling order, create what's missing, then remove what the model no longer has.
5. Save the new baseline, built from what step 4 wrote (as the browser stored it, e.g.
   with normalized URLs) rather than read back, so edits the user makes during step 4 still
   count as local edits next time.

This handles missed events, edits made while the browser was closed, and crashes the same
way: a pass that dies before step 5 leaves the old baseline, and the next pass converges.
Nodes a browser refuses (e.g. Firefox and `javascript:` URLs) are skipped and retried
rather than failing the sync.

**Mass-delete guard:** if a pass would push or apply at least 10 deletions that are also
more than 25% of the folder, the mount pauses before pushing anything. The user either
confirms or puts the bookmarks back (the next pass pushes everything except the deletes,
and the model recreates the missing bookmarks).

## Encryption and pairing (`crypto.ts`, `pairing.ts`)

- Every blob (change, collection name, tab snapshot) is AES-256-GCM with a random IV, plus
  additional data naming its context (`change:<collectionId>`, `meta:<id>`,
  `tabs:<deviceId>`), so the server can't move a blob somewhere else.
- **Pairing:** an existing device shows a one-time 16-character code (80 bits). Both
  devices derive two values from it with HKDF: a lookup id, which the server uses to find
  the pairing, and a wrapping key, which encrypts the account key. The server never sees
  the code or the key. Pairings expire after 10 minutes and work once.
- Device tokens are random 256-bit bearer tokens. The server stores only their SHA-256.

The server sees: device names and browsers, when changes happen and how big they are,
and which device wrote them. Nothing else.

Known gaps in what a *malicious* server could do: it can't read or forge changes, but it
could withhold, replay or reorder them (encryption binds a change to its collection, not
to its position in the log), and a removed device keeps the account key since keys aren't
rotated. Fixing both means chaining changes by hash inside the ciphertext and rotating the
key when a device is removed.

## Server (`apps/server`)

Hono on Node 24 with the built-in `node:sqlite`, bundled into a single file. The same
Docker image runs the hosted service and self-hosted instances. Tables: `accounts`,
`devices`, `collections`, `changes` (`collection_id, seq` primary key, seq assigned in
one `insert … select max(seq) + 1` statement), `tabs`, `pairings`. CORS is open because
clients authenticate with bearer tokens, not cookies.

The extension imports the server's route types (`AppType`) for a fully typed client.

## Extension (`apps/extension`)

- `lib/engine.ts`: every state-changing action runs through one promise queue
  (`exclusive`), so syncs and edits never interleave. UI pages read `storage.local`
  directly and send writes to the background through a typed message channel
  (`lib/messages.ts`).
- Triggers: bookmark events (2 s debounce), tab events (3 s, tabs only), a 1-minute
  alarm, browser startup and the popup's sync button.
- Persisted per collection: the replayed model and cursor. Per mount: links (sync id ↔
  native id) and the baseline.
- Safari has no `bookmarks` API. The build omits the permission and the UI hides mounting,
  so collections are browsed from the popup instead.

## Deliberately not in the MVP

- History, passwords, cookies, extensions and settings sync.
- Native Safari bookmarks (would need a macOS helper app using private APIs).
- Account recovery: losing every paired device loses the key. A printable recovery key is
  the planned fix.
- Log compaction: new devices replay the full log, which is fine at bookmark scale.
- Live push (WebSocket). MV3 service workers make long-lived connections fiddly, and a
  1-minute alarm plus event triggers is enough for bookmarks.
- Named profiles that apply a set of mounts to a new device in one step. Today each browser
  picks its collections and folders individually.
- Rate limiting and billing on the server. `SIGNUP_TOKEN` gates signups for now.
- Smarter folder matching on mount: a folder renamed in one browser before mounting comes
  through as a second folder (its bookmarks are still matched by URL, not duplicated).
