# Chrome Web Store listing

Everything the [developer dashboard](https://chrome.google.com/webstore/devconsole) asks
for, ready to paste. The Firefox (AMO) listing reuses the same text and screenshots.

## Package

```sh
WXT_DEFAULT_SERVER_URL=https://browserlace.skylive.world pnpm --filter @browserlace/extension zip
```

Upload `apps/extension/.output/browserlaceextension-<version>-chrome.zip`. Without
`WXT_DEFAULT_SERVER_URL` the setup screen prefills `localhost`. Tagged releases set it from
the `DEFAULT_SERVER_URL` repository variable, so the zip attached to a GitHub release works too.

## Store listing tab

**Name:** BrowserLace (from the manifest)

**Summary** (from the manifest, 132 characters max):
End-to-end encrypted bookmark and tab sync across Chrome, Firefox and Safari.

**Description:**

```text
Keep the browsers you like. Choose what follows you across them.

BrowserLace syncs the bookmark folders and open tabs you choose across Chrome (and other Chromium browsers), Firefox and Safari. Everything is end-to-end encrypted: the server stores ciphertext and never sees a URL, title or collection name.

COLLECTIONS, NOT EVERYTHING
• A collection is a set of bookmarks you choose to sync, like "Work" or "Recipes".
• Each browser decides which collections it syncs, into which folder, and how: two-way, receive only, or send only (this browser's folder is the source of truth).
• Your work laptop can edit "Work" and receive "Personal"; your home PC never has to see "Work".
• Profiles save a browser's setup, so a new browser applies it in one step.

YOUR TABS, EVERYWHERE
• See the tabs open on your other browsers from the toolbar, and open them here.
• Send a tab to any device from the popup or the right-click menu. It opens there right away.
• Changes reach your other open browsers within a second or two.

SAFE BY DEFAULT
• Large deletions pause until you confirm them.
• Every collection keeps a history you can restore from.
• Removing a device rotates the encryption key so it can't read anything new.
• A printable recovery key gets you back in if you lose all your devices.

ADD A BROWSER IN SECONDS
Pair a new browser with a one-time code, link or QR code. Search every collection from the popup, including ones this browser doesn't sync.

OPEN SOURCE, SELF-HOSTABLE
BrowserLace is open source (AGPL-3.0). Use the hosted server, or run your own with one Docker image: https://github.com/SkyliveLLC/BrowserLace

Bookmarks and tabs only, by design. No ads, no analytics, no tracking.
```

**Category:** Productivity (Tools) · **Language:** English

**Graphics:**

| Field | File |
| --- | --- |
| Store icon (128×128) | `apps/extension/public/icon/128.png` (96×96 artwork, 16 px transparent padding) |
| Screenshots (1280×800) | `docs/store/screenshot-1-collections.png` to `screenshot-5-popup-search.png`, in order |
| Small promo tile (440×280) | `docs/store/promo-tile-440x280.png` |

**Official URL / homepage:** `https://github.com/SkyliveLLC/BrowserLace`
**Support URL:** `https://github.com/SkyliveLLC/BrowserLace/issues`

## Privacy practices tab

**Single purpose:**
Sync the bookmark folders and open tabs the user chooses across their browsers, end-to-end encrypted.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `bookmarks` | Reads and writes only the bookmark folders the user chooses to sync, so they match across browsers. |
| `tabs` | Shares this browser's open tab titles and URLs with the user's other devices (the user can turn this off), and opens tabs sent from another device. |
| `storage` | Stores the device's encryption keys, sync state and settings locally. |
| `unlimitedStorage` | Keeps a local copy of each synced collection and its pending changes, which can exceed the default quota for large bookmark sets. |
| `alarms` | Runs a periodic sync so changes arrive even when no live connection is open. |
| `contextMenus` | Adds "Send to device" to the right-click menu for pages and links. |
| `notifications` | Announces a tab sent from the user's other device; clicking the notification switches to that tab. |

**Remote code:** No, I am not using remote code. All code ships in the package.

**Data usage:** tick **Web history** only. Bookmarks and open tabs (URLs and titles) leave the
device, but only end-to-end encrypted; the server can't read them. Nothing else in the list is
collected. Tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** `https://github.com/SkyliveLLC/BrowserLace/blob/main/PRIVACY.md`

## Distribution tab

Free. All regions. Visibility **Public**, or **Unlisted** for a soft launch where only people
with the link can install it.

## Regenerating the screenshots and promo tile

They come from demo data in throwaway browsers, never real bookmarks:

```sh
pnpm --filter @browserlace/extension build
.claude/skills/verify/scripts/verify.sh .claude/skills/verify/scenarios/store-assets.ts /tmp/store-assets
cp /tmp/store-assets/screenshot-*.png /tmp/store-assets/promo-tile-440x280.png docs/store/
```

## Updates

Bump `version` in `apps/extension/package.json`, build the zip as above, and upload it under
**Package → Upload new package**. Reviews of updates are usually faster than the first one.
