# BrowserLace on your tailnet

Runs the sync server privately: only devices on your tailnet can reach it, over HTTPS, with
no ports opened to the internet. Your bookmarks are end-to-end encrypted either way; this
just keeps even the ciphertext at home.

1. In the Tailscale admin console, enable MagicDNS and HTTPS certificates, then create an
   auth key (Settings → Keys).
2. Start it:

   ```sh
   cd deploy/tailscale
   TS_AUTHKEY=tskey-auth-... docker compose up -d
   ```

3. In the extension's setup screen, use `https://browserlace.<your-tailnet>.ts.net` as the
   server. Every browser that syncs needs to be on the tailnet (Tailscale running on that
   machine or phone).

The database lives in the `data` volume. Back it up like any SQLite file (stop the
container, or use `sqlite3 browserlace.db ".backup out.db"`).
