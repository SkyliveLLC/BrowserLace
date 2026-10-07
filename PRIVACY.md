# Privacy policy

BrowserLace syncs bookmark folders and open tabs between your browsers. It's built so the
server can't read what you sync. This policy covers the BrowserLace extension and the
hosted BrowserLace server. If you run your own server, you are its operator and nothing
reaches us.

## What the extension reads

- **Bookmarks** in the folders you choose to sync, and only those folders.
- **Open tabs** (titles and URLs), if "Share this browser's open tabs" is on. You can turn
  it off in settings.
- **Pages you send** to another device, when you use "Send to device".

All of it is encrypted on your device (AES-256-GCM) with keys that exist only on your
devices and in your recovery key. It leaves your device only in encrypted form.

## What the server stores

- Encrypted bookmark changes, snapshots, collection names, profiles, tab lists and sent
  tabs. The server can't decrypt them.
- For each device: the name you gave it, the browser type, its public key, when it was
  added and last seen, and a hash of its access token.
- For each change: when it was made, its size and which device made it.
- Access logs with request method, path, status and duration, kept for operating the
  service. They contain no bookmark content, URLs you visit or tokens.
- On the hosted service, if you subscribe: your plan and subscription status, and the
  Stripe customer id. Payment details go to [Stripe](https://stripe.com/privacy) directly;
  BrowserLace never sees them.

There's no advertising, analytics, tracking or selling of data, and no third parties
besides Stripe for payments and the infrastructure provider hosting the server.

## Retention and deletion

- Old changes are dropped after 365 days once a snapshot covers them.
- Sent tabs are deleted once opened, or after 30 days.
- Removing a device deletes its record and tab list.
- **Settings → Account → Delete account** deletes everything stored for your account on
  the server immediately, and cancels any subscription. Encrypted backups of the server's
  database can hold deleted data until they're rotated out.

Bookmarks already in your browsers are never deleted by any of these.

## Contact

Questions or requests: open an issue at https://github.com/SkyliveLLC/BrowserLace or use
the contact in [SECURITY.md](SECURITY.md) for anything private.
