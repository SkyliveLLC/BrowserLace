# Hosting BrowserLace on Fly.io

This is the setup for the hosted service: one machine, a volume for SQLite, continuous
backups to object storage with Litestream, and Stripe billing. Self-hosting doesn't need
any of this; see [../tailscale](../tailscale/README.md).

The server keeps its database, rate limits and live connections in one process, so run
**exactly one machine**. Don't `fly scale count` above 1.

## First deploy

1. Edit `fly.toml`: set `app`, `primary_region` and `PUBLIC_URL` (your domain, or
   `https://<app>.fly.dev`).
2. Create the app and its volume:

   ```sh
   fly launch --copy-config --no-deploy
   fly volumes create browserlace_data --size 3 --region <region>
   ```

3. Backups. Create a bucket (for example `fly storage create`, which prints S3
   credentials), then:

   ```sh
   fly secrets set \
     LITESTREAM_REPLICA_URL='s3://<bucket>/browserlace?endpoint=fly.storage.tigris.dev&region=auto' \
     LITESTREAM_ACCESS_KEY_ID=<key> LITESTREAM_SECRET_ACCESS_KEY=<secret>
   ```

   On a fresh volume the server restores the latest backup before starting.

4. Billing. In Stripe, create a recurring price for Plus, enable the customer portal, and
   add a webhook endpoint at `<PUBLIC_URL>/billing/webhook` for `checkout.session.completed`
   and `customer.subscription.created`, `.updated` and `.deleted`. Then:

   ```sh
   fly secrets set STRIPE_SECRET_KEY=sk_live_… STRIPE_WEBHOOK_SECRET=whsec_… STRIPE_PRICE_ID=price_…
   ```

   Leave these unset for a free, unlimited server. Plan limits are listed in the main README.

5. `fly deploy`, then check `https://<PUBLIC_URL>/healthz`.

Build the extension for store submission with `WXT_DEFAULT_SERVER_URL=<PUBLIC_URL>` so new
users land on your server.

## Updating

Releases publish `ghcr.io/skylivellc/browserlace-server:<version>` and `:latest`. Pin a
version in `[build] image` for predictable deploys, then `fly deploy`. Migrations run on
start and only ever add to the schema.

## Restoring from backup

Stop the app, create a new empty volume, and start it: the entrypoint restores the newest
backup when the database file is missing. To restore to a point in time, run
`litestream restore -timestamp <RFC3339> -o /data/browserlace.db "$LITESTREAM_REPLICA_URL"`
on the machine before starting the server.
