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
- **Mount**: per browser, a collection mapped to one native folder: `two-way`, `receive`
  (the folder mirrors the collection) or `send` (the collection mirrors the folder, and
  edits made elsewhere are undone). BrowserLace only ever touches mounted folders, never
  the whole bookmark tree, and two mounts can't overlap. Receive-only mounts need a new or
  empty folder, because they replace its contents with bookmarks that were never in any
  history.
- **Profile**: an encrypted, named set of mount rules (collection, mode, folder name),
  saved from one browser and applied on another to set it up in one step.
- **Tab snapshot**: each device's open tabs, replaced wholesale on change. Never merged.
- **Send**: a tab sent to one device, encrypted for the account and addressed by device
  id. The target opens it and deletes it; unopened sends expire after 30 days.

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

**Snapshots and retention.** After every 500 changes, a device uploads an encrypted
snapshot of the replayed model (with the cursor and chain hash). A new device starts from
it instead of replaying the whole log. The server drops changes that a snapshot covers
once they're older than `HISTORY_DAYS` (365 by default); a device whose cursor is older
than that gets `410 Gone` and continues from the snapshot, keeping its mounted folder's
local edits. History and restore then start at the snapshot.

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

**Send-only** mounts diff the folder against the model itself instead of the baseline,
with links to nodes the model no longer shows dropped. The result is exactly the ops that
make the collection match the folder, including undoing other devices' edits; the folder
is never written.

This handles missed events, edits made while the browser was closed, and crashes the same
way: a pass that dies before step 5 leaves the old baseline, and the next pass converges.
Nodes a browser refuses (e.g. Firefox and `javascript:` URLs) are skipped and retried
rather than failing the sync.

**Mass-delete guard:** if a pass would push or apply at least 10 deletions that are also
more than 25% of the folder, the mount pauses before pushing anything. The user either
confirms or puts the bookmarks back (the next pass pushes everything except the deletes,
and the model recreates the missing bookmarks).

## Encryption, keys and recovery (`crypto.ts`, `keys.ts`, `pairing.ts`)

- **Keyring.** An account has one 256-bit key per **epoch**. Every blob (change,
  collection name, tab snapshot) is AES-256-GCM under the current epoch, with a header
  naming the epoch, and additional data naming its context (`change:<collectionId>`,
  `meta:<id>`, `tabs:<deviceId>`) so the server can't move a blob somewhere else.
- **Pairing:** an existing device shows a one-time 16-character code (80 bits). Both
  devices derive two values from it with HKDF: a lookup id, which the server uses to find
  the pairing, and a wrapping key, which encrypts the keyring. The server never sees the
  code or the keys. Pairings expire after 10 minutes and work once. The code is also
  offered as a link (`browserlace://pair?server=…&code=…`) and a QR code of it, so the new
  device gets the server URL in the same step.
- **Device keys.** Each device has an X25519 key pair and registers the public key with
  an **attestation**: an HMAC under an epoch key, which only account devices can make.
- **Removing a device starts a new epoch.** The removing device rotates right away (and
  the server flags the account in case it can't). Rotating means generating a key,
  wrapping it for every device attested under the *current* epoch (ephemeral X25519 →
  HKDF → AES-GCM, a **grant**), re-attesting them under the new epoch and re-sealing
  collection names. Trusting only current attestations means a removed device can't
  vouch for anyone later, since every rotation re-attests the devices it trusts. Each
  grant carries a proof under the previous epoch, so a device only accepts keys an
  account device made. Only one device can start an epoch, and the server refuses one
  that leaves out a currently attested device; the loser retries or picks up the grants.
  Old changes stay under old epochs (the removed device already had them); it can't read
  anything written afterwards. Pairing codes record their epoch and stop working after a
  rotation, and devices refresh keys before sealing anything new.
- **Recovery key.** 32 random bytes, shown once as Crockford base32. It acts as a device
  on paper: the bytes are an X25519 private key that receives grants like any device, and
  an HKDF-derived lookup id lets a new browser find the account and claim a device token.
  Its first grant (the whole keyring) is authenticated with a MAC derived from the
  recovery key itself. Creating a new one replaces the old and starts a new epoch, since
  the old one could still open the current epoch's grant.
- **Tamper-evident logs.** Each change names the SHA-256 of the change before it (of the
  ciphertext, so an unreadable change still links the chain). A device that sees a
  change out of order, replayed or missing stops syncing that collection and says why.
- Device tokens are random 256-bit bearer tokens. The server stores only their SHA-256.

The server sees: device names and browsers, public keys, when changes happen and how big
they are, and which device wrote them. Nothing else.

What a *malicious* server can still do: withhold the newest changes (a device can't tell
"nothing new" from "hidden"), or show different devices different logs. A server colluding with a removed device could slip in a
device of its own before the removal (while the removed device still had the current
key); every device is listed in settings, so it would show there.

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
- Triggers: bookmark events (2 s debounce), tab events (3 s, tabs only), live events, a
  1-minute alarm, browser startup and the popup's sync button.
- **Live events** (`lib/live.ts`): one WebSocket to `/v1/events`, authenticated by its
  first message. After any write the server tells the account's other sockets what kind
  of thing changed (never the content), and they sync within a second. The socket sends
  a keepalive every 20 s, which also keeps Chrome's service worker alive; it reconnects
  with backoff, and the alarm reopens it if Firefox or Safari unloaded the background.
- Persisted per collection: the replayed model and cursor. Per mount: links (sync id ↔
  native id) and the baseline.
- Safari has no `bookmarks` API. The build omits the permission and the UI hides mounting,
  so collections are browsed from the popup instead.

## Deliberately not in the MVP

- History, passwords, cookies, extensions and settings sync.
- Native Safari bookmarks (would need a macOS helper app using private APIs).
- Rate limiting and billing on the server. `SIGNUP_TOKEN` gates signups for now.
- Smarter folder matching on mount: a folder renamed in one browser before mounting comes
  through as a second folder (its bookmarks are still matched by URL, not duplicated).
