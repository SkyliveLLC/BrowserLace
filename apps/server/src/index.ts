import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApp, defaultRateLimits, SEND_TTL_MS } from "./app.ts";
import { plansFromEnv, stripeBilling } from "./billing.ts";
import { cleanupExpired, openDatabase, pruneHistory } from "./db.ts";
import { Events } from "./events.ts";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const db = openDatabase(env.DATABASE_PATH ?? "browserlace.db");
const events = new Events();
const DAY = 24 * 60 * 60 * 1000;

// Daily: drop changes older than HISTORY_DAYS that a snapshot covers, and expired pairings and sends.
const historyDays = Number(env.HISTORY_DAYS ?? 365);
const maintain = () => {
  const dropped = pruneHistory(db, Date.now() - historyDays * DAY);
  cleanupExpired(db, Date.now(), SEND_TTL_MS);
  if (dropped > 0) console.log(JSON.stringify({ msg: "pruned old changes", dropped }));
};
maintain();
const maintenance = setInterval(maintain, DAY);

// Billing (and plan limits) only when every Stripe setting is present: the hosted service, not self-hosting.
const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, PUBLIC_URL } = env;
const billing =
  STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET && STRIPE_PRICE_ID && PUBLIC_URL
    ? {
        provider: stripeBilling({
          secretKey: STRIPE_SECRET_KEY,
          webhookSecret: STRIPE_WEBHOOK_SECRET,
          priceId: STRIPE_PRICE_ID,
          publicUrl: PUBLIC_URL.replace(/\/+$/, ""),
        }),
        plans: plansFromEnv(env),
      }
    : undefined;

const app = createApp({
  db,
  events,
  billing,
  signupToken: env.SIGNUP_TOKEN || undefined,
  trustProxy: env.TRUST_PROXY || undefined,
  rateLimits: {
    ip: defaultRateLimits.ip,
    device: {
      burst: Number(env.DEVICE_REQUESTS_PER_MINUTE ?? defaultRateLimits.device.burst),
      perMinute: Number(env.DEVICE_REQUESTS_PER_MINUTE ?? defaultRateLimits.device.perMinute),
    },
  },
  log: env.ACCESS_LOG === "off" ? undefined : (entry) => console.log(JSON.stringify(entry)),
});

const server = serve({ fetch: app.fetch, port, websocket: { server: new WebSocketServer({ noServer: true }) } }, ({ port }) => {
  console.log(JSON.stringify({ msg: "listening", port, billing: billing !== undefined }));
});

// Finish in-flight requests, then close the database. Give up after 10 seconds.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(maintenance);
    events.closeAll();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
