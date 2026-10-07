# BrowserLace

Keep the browsers you like. Choose what follows you across them.

BrowserLace syncs bookmark folders and open tabs across Chrome (and other Chromium
browsers), Firefox and Safari. Everything is end-to-end encrypted: the server stores
ciphertext and never sees a URL, title or collection name. Use the hosted server, or run
your own on your tailnet.

**Status: early release.** Bookmarks and tabs only. See [docs/architecture.md](docs/architecture.md)
for how it works and what's deliberately left out.

## How it works for users

- **Collections** are sets of bookmarks you choose to sync, like "Work" or "Research".
- Each browser decides which collections it syncs and into which folder: **two-way**,
  **receive only** or **send only** (this browser's folder is the source of truth). A work
  laptop can receive "Personal" and edit "Work"; a home PC might never see "Work".
- **Profiles** save a browser's setup ("Work laptop") so a new browser applies it in one step.
- **Pairing** a new browser takes a one-time code, link or QR code. The popup searches every
  collection, which is how Safari reaches them.
- **Other devices** in the toolbar popup shows each browser's open tabs, so you can pick
  up where you left off without merging every session together. **Send a tab** to any
  device from the popup or the right-click menu; it opens there right away.
- Changes reach your other browsers within a second or two while they're open.
- **Safety:** large deletions pause until you confirm, and every collection keeps a
  history you can restore from.
- **Your keys, your devices:** removing a device rotates the encryption key so it can't
  read anything new, and a printable recovery key gets you back in if you lose them all.
- **Safari** can't edit its bookmarks from an extension (Apple doesn't expose the API), so
  there collections open from the toolbar popup instead. Tabs work fully.

## Repository

| Path              | What                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `packages/core`   | Sync engine: op model, reconciliation, encryption, pairing. Pure TS.     |
| `apps/server`     | Sync server: Hono + SQLite (built into Node 24). One Docker image.       |
| `apps/extension`  | WXT extension for Chrome, Firefox and Safari. React UI.                  |
| `deploy/tailscale`| Compose file to self-host the server privately on a tailnet.             |

## Development

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm test        # core + server tests
pnpm typecheck

pnpm dev:server      # http://localhost:8787, database in apps/server/browserlace.db
pnpm dev:extension   # launches Chrome with the extension loaded (WXT dev mode)
```

End-to-end runs drive isolated browser profiles (never yours) against a throwaway server:

```sh
pnpm build && pnpm --filter @browserlace/e2e chromium
```

`pnpm --filter @browserlace/extension dev:firefox` does the same for Firefox. Set
`WXT_DEFAULT_SERVER_URL` (see `apps/extension/.env.example`) to change the server
prefilled in the setup screen.

## Building

```sh
pnpm build   # server bundle + chrome-mv3, firefox-mv3 and safari-mv3 extension builds
pnpm --filter @browserlace/extension zip            # store-ready zips for Chrome and Firefox
pnpm --filter @browserlace/extension safari:xcode   # Xcode wrapper app for Safari (macOS, needs Xcode)
```

Safari extensions ship inside a native app: open `apps/extension/safari` in Xcode, set your
team for signing, and run the macOS (or iOS) scheme. For local testing, enable Safari →
Settings → Developer → Allow unsigned extensions.

Store identifiers are set at build time (in the environment or `apps/extension/.env`):

| Variable                 | Default                        | Meaning                                                  |
| ------------------------ | ------------------------------ | -------------------------------------------------------- |
| `WXT_DEFAULT_SERVER_URL` | `http://localhost:8787`        | Server prefilled in the setup screen                     |
| `WXT_FIREFOX_ADDON_ID`   | `browserlace@browserlace.app`  | Firefox add-on id. Never change it after the first AMO upload |
| `SAFARI_BUNDLE_ID`       | `app.browserlace.BrowserLace`  | Bundle id of the Safari wrapper app (`safari:xcode`)     |

### Releases

CI runs typecheck, tests, builds, Mozilla's linter and a Docker smoke test on every PR.
Pushing a tag that matches `apps/extension/package.json`'s version (e.g. `v0.2.0`)
publishes a GitHub release with the Chrome and Firefox zips and pushes the server image to
`ghcr.io/skylivellc/browserlace-server`. Set the repository variables `DEFAULT_SERVER_URL`
and `FIREFOX_ADDON_ID` for store builds.

## Running the server

```sh
docker run -p 8787:8787 -v browserlace:/data ghcr.io/skylivellc/browserlace-server
# or build it yourself from the repo root:
docker build -f apps/server/Dockerfile -t browserlace-server .
```

| Variable        | Default                  | Meaning                                                    |
| --------------- | ------------------------ | ---------------------------------------------------------- |
| `PORT`          | `8787`                   | HTTP port                                                  |
| `DATABASE_PATH` | `/data/browserlace.db`   | SQLite file (`browserlace.db` outside Docker)              |
| `SIGNUP_TOKEN`  | unset                    | If set, creating an account requires it. Use it for invite-only servers. |
| `HISTORY_DAYS`  | `365`                    | Changes older than this are dropped once a snapshot covers them; history and restore go back this far |

### Billing (hosted service only)

Billing and plan limits turn on only when all four Stripe settings are set. Without them
(self-hosting) there are no limits and no billing UI.

| Variable                | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | Stripe API key                                                          |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint `https://<server>/billing/webhook` |
| `STRIPE_PRICE_ID`       | Recurring price for the Plus plan                                       |
| `PUBLIC_URL`            | The server's public URL, where Stripe sends people back after checkout  |
| `FREE_DEVICES`, `FREE_COLLECTIONS`, `FREE_STORAGE_MB` | Free plan limits (default 3, 5, 25)       |
| `PLUS_DEVICES`, `PLUS_COLLECTIONS`, `PLUS_STORAGE_MB` | Plus plan limits (default 20, 200, 1024)  |

The webhook needs the events `checkout.session.completed` and `customer.subscription.created`,
`.updated` and `.deleted`. Enable the customer portal in Stripe so people can manage or cancel.

Put it behind HTTPS (any reverse proxy) for the hosted service. To self-host privately on
a tailnet, see [deploy/tailscale](deploy/tailscale/README.md).

## License

[AGPL-3.0](LICENSE). You can use, modify and self-host BrowserLace freely; if you offer a
modified version as a hosted service, you must publish your changes under the same license.
