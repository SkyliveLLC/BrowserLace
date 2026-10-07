/**
 * The sync server. It authenticates devices, orders each collection's changes and stores
 * encrypted blobs. It never sees bookmark content, tab URLs or collection names.
 *
 * The extension imports `AppType` for a typed client (`hc<AppType>`).
 */
import { upgradeWebSocket } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { zValidator } from "@hono/zod-validator";
import { Hono, type ValidationTargets } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { planFor, type Billing, type Plan, type Plans, type SubscriptionState } from "./billing.ts";
import { transaction, type Database } from "./db.ts";
import { Events } from "./events.ts";
import { rateLimiter, type RateLimit } from "./ratelimit.ts";

/** Validates a request part, answering 400 itself so error shapes stay out of the client types. */
const valid = <Target extends keyof ValidationTargets, Schema extends z.ZodType>(target: Target, schema: Schema) =>
  zValidator(target, schema, (result) => {
    if (!result.success) throw new HTTPException(400, { message: z.prettifyError(result.error) });
  });

/** Base64url ciphertext as produced by the core package's `seal`. */
const blob = (maxLength: number) => z.string().min(1).max(maxLength).regex(/^[\w-]+$/);
const deviceInfo = z.object({ name: z.string().trim().min(1).max(80), browser: z.string().trim().min(1).max(40) });
const lookupId = z.string().length(43).regex(/^[\w-]+$/);
/** A 32-byte value in base64url: X25519 public keys and HMAC attestations. */
const key32 = z.string().length(43).regex(/^[\w-]+$/);
const epoch = z.number().int().positive();
/** `<ephemeral public key>.<ciphertext>`, as produced by the core package's `sealGrant`. */
const grantBlob = z.string().max(65_536).regex(/^[\w-]{43}\.[\w-]+$/);
/** Grants and attestations for the recovery key use this recipient id instead of a device id. */
const RECOVERY = "recovery";

const PAIRING_TTL_MS = 10 * 60 * 1000;
export const SEND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PULL_PAGE = 500;

type Device = { id: string; account_id: string };
type Env = { Variables: { device: Device } };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** The token in a WebSocket's first message, `{ "token": "…" }`. */
function authMessage(text: string): string | undefined {
  try {
    return z.object({ token: z.string() }).parse(JSON.parse(text)).token;
  } catch {
    return undefined;
  }
}

export type AppOptions = {
  db: Database;
  /** When set, creating an account requires this token. Leave unset for open signup. */
  signupToken?: string | undefined;
  now?: () => number;
  events?: Events;
  /** Paid plans. Without it there's no billing UI and no limits (self-hosting). */
  billing?: { provider: Billing; plans: Plans } | undefined;
  /** Per client IP on sign-up and claim routes, and per device on everything else. */
  rateLimits?: { ip: RateLimit; device: RateLimit };
  /**
   * Header carrying the client's IP when behind a reverse proxy (e.g. `fly-client-ip`,
   * `x-forwarded-for`). Without it, the socket's address is used.
   */
  trustProxy?: string | undefined;
  /** Called once per request, for access logs. Never given bodies or tokens. */
  log?: (entry: { method: string; path: string; status: number; ms: number }) => void;
};

export const defaultRateLimits = { ip: { burst: 20, perMinute: 10 }, device: { burst: 600, perMinute: 600 } };

export function createApp({
  db,
  signupToken,
  now = Date.now,
  events = new Events(),
  billing,
  rateLimits = defaultRateLimits,
  trustProxy,
  log,
}: AppOptions) {
  const clientIp = (c: Context) => {
    if (trustProxy) return c.req.header(trustProxy)?.split(",").at(-1)?.trim() ?? "unknown";
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown"; // Not a Node request (tests).
    }
  };
  const ipLimit = rateLimiter(rateLimits.ip);
  const deviceLimit = rateLimiter(rateLimits.device);
  const tooMany = () => new HTTPException(429, { message: "Too many requests; try again in a minute" });
  /** Guards routes anyone can call, which could otherwise be used to guess or spam. */
  const perIp = createMiddleware(async (c, next) => {
    if (!ipLimit(clientIp(c), now())) throw tooMany();
    await next();
  });

  const usage = (accountId: string) =>
    db
      .prepare(
        `select
           (select count(*) from devices where account_id = ?1) as devices,
           (select count(*) from collections where account_id = ?1) as collections,
           (select coalesce(sum(length(ch.blob)), 0) from changes ch join collections c on c.id = ch.collection_id where c.account_id = ?1)
             + (select coalesce(sum(length(s.blob)), 0) from snapshots s join collections c on c.id = s.collection_id where c.account_id = ?1)
             as storageBytes`,
      )
      .get(accountId) as { devices: number; collections: number; storageBytes: number };

  const limitsFor = (accountId: string) => {
    if (!billing) return null;
    const { plan } = db.prepare("select plan from accounts where id = ?").get(accountId) as { plan: Plan };
    return billing.plans[plan];
  };

  /** Throws 402 if adding to the account would go over its plan. */
  const checkLimit = (accountId: string, adding: { devices?: number; collections?: number; storageBytes?: number }) => {
    const limits = limitsFor(accountId);
    if (!limits) return;
    const used = usage(accountId);
    const over =
      (adding.devices && used.devices + adding.devices > limits.devices && `Your plan allows ${limits.devices} devices`) ||
      (adding.collections && used.collections + adding.collections > limits.collections && `Your plan allows ${limits.collections} collections`) ||
      (adding.storageBytes &&
        used.storageBytes + adding.storageBytes > limits.storageBytes &&
        `Your plan's ${Math.round(limits.storageBytes / 1024 / 1024)} MB of storage is full`);
    if (over) throw new HTTPException(402, { message: `${over}. Upgrade in BrowserLace's settings.` });
  };

  const applySubscription = (state: SubscriptionState) => {
    const plan = planFor(state.status);
    const { changes } = db
      .prepare(
        `update accounts set stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ?, plan = ?
         where id = ? or (? is null and stripe_customer_id = ?)`,
      )
      .run(state.customerId, state.subscriptionId, state.status, plan, state.accountId ?? null, state.accountId ?? null, state.customerId);
    if (changes === 0) console.warn(`Stripe subscription ${state.subscriptionId} matches no account`);
  };
  const issueDevice = (accountId: string, info: z.output<typeof deviceInfo>) => {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    db.prepare(
      "insert into devices (id, account_id, name, browser, token_hash, created_at, last_seen_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, accountId, info.name, info.browser, hashToken(token), now(), now());
    return { accountId, deviceId: id, token };
  };

  const deviceForToken = (token: string | undefined) =>
    token ? (db.prepare("select id, account_id from devices where token_hash = ?").get(hashToken(token)) as Device | undefined) : undefined;

  const auth = createMiddleware<Env>(async (c, next) => {
    const device = deviceForToken(c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1]);
    if (!device) throw new HTTPException(401, { message: "Unknown or revoked device" });
    if (!deviceLimit(device.id, now())) throw tooMany();
    db.prepare("update devices set last_seen_at = ? where id = ?").run(now(), device.id);
    c.set("device", device);
    await next();
  });

  /** Throws 404 unless the collection belongs to the caller's account. */
  const ownCollection = (device: Device, collectionId: string) => {
    const row = db.prepare("select id from collections where id = ? and account_id = ?").get(collectionId, device.account_id);
    if (!row) throw new HTTPException(404, { message: "Collection not found" });
  };

  /** A `:id` path parameter. Collection and profile ids are client-generated UUIDs. */
  const idParam = valid("param", z.object({ id: z.uuid() }));

  const app = new Hono<Env>()
    .use(async (c, next) => {
      const started = performance.now();
      await next();
      log?.({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) });
    })
    .use(secureHeaders())
    // Clients authenticate with bearer tokens, never cookies, so any origin may call us.
    .use(cors())
    // Room for a snapshot of a very large collection; everything else is far smaller.
    .use(bodyLimit({ maxSize: 16 * 1024 * 1024 }))
    .onError((err, c) => {
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: "Internal error" }, 500);
    })
    .get("/healthz", (c) => {
      db.prepare("select 1").get();
      return c.json({ ok: true });
    })

    /** Stripe's webhook. Verified by signature, so it sits outside device auth. */
    .post("/billing/webhook", async (c) => {
      if (!billing) throw new HTTPException(404, { message: "Billing is not enabled" });
      const state = await billing.provider
        .webhook(await c.req.text(), c.req.header("stripe-signature") ?? "")
        .catch((error: unknown) => {
          throw new HTTPException(400, { message: `Invalid webhook: ${error instanceof Error ? error.message : String(error)}` });
        });
      if (state) applySubscription(state);
      return c.json({ received: true });
    })

    /** Where Stripe sends the browser back after checkout or the portal. */
    .get("/billing/return", (c) =>
      c.html(
        `<!doctype html><meta name="viewport" content="width=device-width"><title>BrowserLace</title>
         <body style="font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em">
         <h1>${c.req.query("done") ? "You're all set" : "No changes made"}</h1>
         <p>${c.req.query("done") ? "Your BrowserLace plan is updated. " : ""}You can close this tab.</p>`,
      ),
    )

    .post("/v1/accounts", perIp, valid("json", deviceInfo.extend({ signupToken: z.string().optional() })), (c) => {
      const { signupToken: given, ...info } = c.req.valid("json");
      if (signupToken && given !== signupToken) throw new HTTPException(403, { message: "Signup token required" });
      const accountId = randomUUID();
      db.prepare("insert into accounts (id, created_at) values (?, ?)").run(accountId, now());
      return c.json(issueDevice(accountId, info), 201);
    })

    .post(
      "/v1/pairings/claim",
      perIp,
      valid("json", deviceInfo.extend({ lookupId })),
      (c) => {
        const { lookupId, ...info } = c.req.valid("json");
        const pairing = db
          .prepare("delete from pairings where lookup_id = ? and expires_at > ? returning account_id, wrapped_key, key_epoch")
          .get(lookupId, now()) as { account_id: string; wrapped_key: string; key_epoch: number } | undefined;
        if (!pairing) throw new HTTPException(404, { message: "Pairing code not found or expired" });
        checkLimit(pairing.account_id, { devices: 1 });
        // The code wraps the keyring as it was; after a rotation the new device would be missing a key.
        const account = db.prepare("select key_epoch from accounts where id = ?").get(pairing.account_id) as { key_epoch: number };
        if (account.key_epoch !== pairing.key_epoch) {
          throw new HTTPException(409, { message: "This pairing code was made before your account's keys changed. Create a new one." });
        }
        return c.json({ ...issueDevice(pairing.account_id, info), wrappedKey: pairing.wrapped_key }, 201);
      },
    )

    .post("/v1/recovery/claim", perIp, valid("json", deviceInfo.extend({ lookupId })), (c) => {
      const { lookupId, ...info } = c.req.valid("json");
      const recovery = db.prepare("select account_id from recovery where lookup_id = ?").get(lookupId) as
        | { account_id: string }
        | undefined;
      if (!recovery) throw new HTTPException(404, { message: "No account uses that recovery key" });
      checkLimit(recovery.account_id, { devices: 1 });
      const grants = db
        .prepare("select epoch, blob from grants where account_id = ? and recipient_id = ? order by epoch")
        .all(recovery.account_id, RECOVERY) as { epoch: number; blob: string }[];
      return c.json({ ...issueDevice(recovery.account_id, info), grants }, 201);
    })

    /**
     * Live events. Browsers can't set headers on a WebSocket, so the first message
     * authenticates: `{ "token": "…" }`. Later messages are keepalives and are ignored.
     */
    .get(
      "/v1/events",
      perIp,
      upgradeWebSocket(() => {
        let unsubscribe: (() => void) | undefined;
        return {
          onMessage(event, ws) {
            if (unsubscribe) return;
            const device = deviceForToken(typeof event.data === "string" ? authMessage(event.data) : undefined);
            if (!device) return ws.close(4001, "Unknown or revoked device");
            unsubscribe = events.subscribe(device.account_id, {
              deviceId: device.id,
              send: (e) => ws.send(JSON.stringify(e)),
              close: () => ws.close(4001, "Device removed"),
            });
            ws.send(JSON.stringify({ type: "ready" }));
          },
          onClose() {
            unsubscribe?.();
          },
        };
      }),
    )

    .use("/v1/*", auth)

    .post("/v1/pairings", valid("json", z.object({ lookupId, wrappedKey: blob(65_536), epoch })), (c) => {
      const { lookupId, wrappedKey, epoch } = c.req.valid("json");
      const accountId = c.var.device.account_id;
      const account = db.prepare("select key_epoch from accounts where id = ?").get(accountId) as { key_epoch: number };
      if (account.key_epoch !== epoch) throw new HTTPException(409, { message: "Keys changed; sync and try again" });
      const expiresAt = now() + PAIRING_TTL_MS;
      db.prepare("insert into pairings (lookup_id, account_id, wrapped_key, expires_at, key_epoch) values (?, ?, ?, ?, ?)").run(
        lookupId,
        accountId,
        wrappedKey,
        expiresAt,
        epoch,
      );
      return c.json({ expiresAt }, 201);
    })

    /** Plan, usage and limits. `limits` is null on servers without billing. */
    .get("/v1/account", (c) => {
      const accountId = c.var.device.account_id;
      const account = db.prepare("select plan, subscription_status as status, stripe_customer_id as customerId from accounts where id = ?").get(
        accountId,
      ) as { plan: Plan; status: string | null; customerId: string | null };
      return c.json({
        plan: account.plan,
        status: account.status,
        billingEnabled: billing !== undefined,
        canManageBilling: account.customerId !== null,
        limits: limitsFor(accountId),
        usage: usage(accountId),
      });
    })

    .post("/v1/billing/checkout", async (c) => {
      if (!billing) throw new HTTPException(404, { message: "Billing is not enabled" });
      const accountId = c.var.device.account_id;
      const { customerId } = db.prepare("select stripe_customer_id as customerId from accounts where id = ?").get(accountId) as {
        customerId: string | null;
      };
      return c.json({ url: await billing.provider.checkoutUrl({ accountId, customerId }) });
    })

    .post("/v1/billing/portal", async (c) => {
      if (!billing) throw new HTTPException(404, { message: "Billing is not enabled" });
      const { customerId } = db.prepare("select stripe_customer_id as customerId from accounts where id = ?").get(c.var.device.account_id) as {
        customerId: string | null;
      };
      if (!customerId) throw new HTTPException(409, { message: "This account has no billing yet" });
      return c.json({ url: await billing.provider.portalUrl(customerId) });
    })

    /** Deletes the account and everything in it, for every device, and ends any subscription. */
    .delete("/v1/account", async (c) => {
      const accountId = c.var.device.account_id;
      const { subscriptionId, status } = db
        .prepare("select stripe_subscription_id as subscriptionId, subscription_status as status from accounts where id = ?")
        .get(accountId) as { subscriptionId: string | null; status: string | null };
      // Cancel first: if Stripe fails, keep the account rather than keep billing a deleted one.
      if (billing && subscriptionId && status !== "canceled") await billing.provider.cancel(subscriptionId);
      const devices = db.prepare("select id from devices where account_id = ?").all(accountId) as { id: string }[];
      db.prepare("delete from accounts where id = ?").run(accountId);
      for (const { id } of devices) events.disconnect(accountId, id);
      return c.json({ ok: true });
    })

    .get("/v1/me", (c) => {
      const devices = db
        .prepare(
          "select id, name, browser, created_at as createdAt, last_seen_at as lastSeenAt from devices where account_id = ? order by created_at",
        )
        .all(c.var.device.account_id) as { id: string; name: string; browser: string; createdAt: number; lastSeenAt: number }[];
      return c.json({ accountId: c.var.device.account_id, deviceId: c.var.device.id, devices });
    })

    .patch("/v1/devices/me", valid("json", deviceInfo.pick({ name: true })), (c) => {
      db.prepare("update devices set name = ? where id = ?").run(c.req.valid("json").name, c.var.device.id);
      return c.json({ ok: true });
    })

    .delete("/v1/devices/:id", valid("param", z.object({ id: z.uuid() })), (c) => {
      const { id } = c.req.valid("param");
      const accountId = c.var.device.account_id;
      transaction(db, () => {
        const { changes } = db.prepare("delete from devices where id = ? and account_id = ?").run(id, accountId);
        if (changes === 0) throw new HTTPException(404, { message: "Device not found" });
        db.prepare("delete from grants where account_id = ? and recipient_id = ?").run(accountId, id);
        // The removed device knows the current key, so the next device to sync starts a new epoch.
        db.prepare("update accounts set rotation_needed = 1 where id = ?").run(accountId);
      });
      events.disconnect(accountId, id);
      events.publish(accountId, { type: "keys", from: c.var.device.id });
      return c.json({ ok: true });
    })

    /**
     * Registers this device's public key, once, attested under the current epoch. Rotations
     * only trust current attestations, so an older one would never receive new keys.
     */
    .put("/v1/devices/me/key", valid("json", z.object({ publicKey: key32, proof: key32, proofEpoch: epoch })), (c) => {
      const { publicKey, proof, proofEpoch } = c.req.valid("json");
      const account = db.prepare("select key_epoch from accounts where id = ?").get(c.var.device.account_id) as { key_epoch: number };
      if (account.key_epoch !== proofEpoch) throw new HTTPException(409, { message: "This device's keys are out of date. Pair it again." });
      const { changes } = db
        .prepare("update devices set public_key = ?, key_proof = ?, key_proof_epoch = ? where id = ? and public_key is null")
        .run(publicKey, proof, proofEpoch, c.var.device.id);
      if (changes === 0) throw new HTTPException(409, { message: "This device already has a key" });
      return c.json({ ok: true });
    })

    /** The account's key state: current epoch, grants for this device, and who can receive new keys. */
    .get("/v1/keys", (c) => {
      const accountId = c.var.device.account_id;
      const account = db.prepare("select key_epoch, rotation_needed from accounts where id = ?").get(accountId) as {
        key_epoch: number;
        rotation_needed: number;
      };
      const grants = db
        .prepare("select epoch, blob from grants where account_id = ? and recipient_id = ? order by epoch")
        .all(accountId, c.var.device.id) as { epoch: number; blob: string }[];
      const holders = db
        .prepare(
          `select id, public_key as publicKey, key_proof as proof, key_proof_epoch as proofEpoch
           from devices where account_id = ? and public_key is not null
           union all
           select ?, public_key, key_proof, key_proof_epoch from recovery where account_id = ?`,
        )
        .all(accountId, RECOVERY, accountId) as { id: string; publicKey: string; proof: string; proofEpoch: number }[];
      return c.json({ epoch: account.key_epoch, rotationNeeded: account.rotation_needed === 1, grants, holders });
    })

    /**
     * Starts epoch `epoch`. Only one device can win; the rest get 409 and pick up the grants.
     * Also 409 if it leaves out a holder attested under the current epoch (one that registered
     * after the rotating device listed holders), so the rotation is retried with it included.
     */
    .post(
      "/v1/keys",
      valid(
        "json",
        z.object({
          epoch: epoch.min(2),
          grants: z.array(z.object({ recipientId: z.string(), blob: grantBlob })).max(1000),
          attestations: z.array(z.object({ recipientId: z.string(), proof: key32 })).max(1000),
          /** Collection names re-sealed under the new epoch. `previous` guards against overwriting a rename. */
          metas: z.array(z.object({ collectionId: z.uuid(), meta: blob(4096), previous: blob(4096) })).max(10_000),
        }),
      ),
      (c) => {
        const body = c.req.valid("json");
        const accountId = c.var.device.account_id;
        transaction(db, () => {
          const { changes } = db
            .prepare("update accounts set key_epoch = ?, rotation_needed = 0 where id = ? and key_epoch = ?")
            .run(body.epoch, accountId, body.epoch - 1);
          if (changes === 0) throw new HTTPException(409, { message: "Another device already started a new epoch" });
          const granted = new Set(body.grants.map((g) => g.recipientId));
          const current = db
            .prepare(
              `select id from devices where account_id = ? and public_key is not null and key_proof_epoch = ?
               union all select ? from recovery where account_id = ? and key_proof_epoch = ?`,
            )
            .all(accountId, body.epoch - 1, RECOVERY, accountId, body.epoch - 1) as { id: string }[];
          if (current.some(({ id }) => !granted.has(id))) {
            throw new HTTPException(409, { message: "A device registered during the rotation; retry" });
          }
          const isHolder = (id: string) =>
            id === RECOVERY
              ? db.prepare("select 1 from recovery where account_id = ?").get(accountId) !== undefined
              : db.prepare("select 1 from devices where id = ? and account_id = ?").get(id, accountId) !== undefined;
          for (const grant of body.grants) {
            if (!isHolder(grant.recipientId)) continue;
            db.prepare("insert into grants (account_id, recipient_id, epoch, blob) values (?, ?, ?, ?)").run(
              accountId,
              grant.recipientId,
              body.epoch,
              grant.blob,
            );
          }
          for (const { recipientId, proof } of body.attestations) {
            if (recipientId === RECOVERY) {
              db.prepare("update recovery set key_proof = ?, key_proof_epoch = ? where account_id = ?").run(proof, body.epoch, accountId);
            } else {
              db.prepare("update devices set key_proof = ?, key_proof_epoch = ? where id = ? and account_id = ?").run(
                proof,
                body.epoch,
                recipientId,
                accountId,
              );
            }
          }
          for (const { collectionId, meta, previous } of body.metas) {
            db.prepare("update collections set meta = ? where id = ? and account_id = ? and meta = ?").run(
              meta,
              collectionId,
              accountId,
              previous,
            );
          }
        });
        events.publish(accountId, { type: "keys", from: c.var.device.id });
        return c.json({ ok: true });
      },
    )

    /** Sets (or replaces) the account's recovery key, granted the keyring as of `epoch`. */
    .put(
      "/v1/recovery",
      valid("json", z.object({ lookupId, publicKey: key32, proof: key32, proofEpoch: epoch, epoch, grant: grantBlob })),
      (c) => {
        const body = c.req.valid("json");
        const accountId = c.var.device.account_id;
        transaction(db, () => {
          const account = db.prepare("select key_epoch from accounts where id = ?").get(accountId) as { key_epoch: number };
          if (account.key_epoch !== body.epoch) throw new HTTPException(409, { message: "Keys changed; sync and try again" });
          const { changes: replaced } = db.prepare("delete from grants where account_id = ? and recipient_id = ?").run(accountId, RECOVERY);
          // The old key can still open the current epoch's grant, so move on to a new epoch.
          if (replaced > 0) db.prepare("update accounts set rotation_needed = 1 where id = ?").run(accountId);
          db.prepare(
            `insert into recovery (account_id, lookup_id, public_key, key_proof, key_proof_epoch, created_at) values (?, ?, ?, ?, ?, ?)
             on conflict (account_id) do update set lookup_id = excluded.lookup_id, public_key = excluded.public_key,
               key_proof = excluded.key_proof, key_proof_epoch = excluded.key_proof_epoch, created_at = excluded.created_at`,
          ).run(accountId, body.lookupId, body.publicKey, body.proof, body.proofEpoch, now());
          db.prepare("insert into grants (account_id, recipient_id, epoch, blob) values (?, ?, ?, ?)").run(
            accountId,
            RECOVERY,
            body.epoch,
            body.grant,
          );
        });
        return c.json({ ok: true });
      },
    )

    .get("/v1/recovery", (c) => {
      const row = db.prepare("select created_at as createdAt from recovery where account_id = ?").get(c.var.device.account_id) as
        | { createdAt: number }
        | undefined;
      return c.json({ recovery: row ?? null });
    })

    .get("/v1/collections", (c) => {
      const collections = db
        .prepare(
          `select c.id, c.meta, c.created_at as createdAt, max(coalesce(max(ch.seq), 0), c.pruned_seq) as headSeq,
             coalesce((select seq from snapshots s where s.collection_id = c.id), 0) as snapshotSeq
           from collections c left join changes ch on ch.collection_id = c.id
           where c.account_id = ? group by c.id order by c.created_at`,
        )
        .all(c.var.device.account_id) as { id: string; meta: string; createdAt: number; headSeq: number; snapshotSeq: number }[];
      return c.json({ collections });
    })

    .post("/v1/collections", valid("json", z.object({ id: z.uuid(), meta: blob(4096) })), (c) => {
      const { id, meta } = c.req.valid("json");
      checkLimit(c.var.device.account_id, { collections: 1 });
      try {
        db.prepare("insert into collections (id, account_id, meta, created_at) values (?, ?, ?, ?)").run(
          id,
          c.var.device.account_id,
          meta,
          now(),
        );
      } catch {
        throw new HTTPException(409, { message: "Collection already exists" });
      }
      events.publish(c.var.device.account_id, { type: "collections", from: c.var.device.id });
      return c.json({ id }, 201);
    })

    .put("/v1/collections/:id", idParam, valid("json", z.object({ meta: blob(4096) })), (c) => {
      const { id } = c.req.valid("param");
      ownCollection(c.var.device, id);
      db.prepare("update collections set meta = ? where id = ?").run(c.req.valid("json").meta, id);
      events.publish(c.var.device.account_id, { type: "collections", from: c.var.device.id });
      return c.json({ ok: true });
    })

    .delete("/v1/collections/:id", idParam, (c) => {
      const { id } = c.req.valid("param");
      ownCollection(c.var.device, id);
      db.prepare("delete from collections where id = ?").run(id);
      events.publish(c.var.device.account_id, { type: "collections", from: c.var.device.id });
      return c.json({ ok: true });
    })

    .get(
      "/v1/collections/:id/changes",
      idParam,
      valid("query", z.object({ after: z.coerce.number().int().min(0).default(0) })),
      (c) => {
        const { id } = c.req.valid("param");
        ownCollection(c.var.device, id);
        const { pruned_seq: pruned } = db.prepare("select pruned_seq from collections where id = ?").get(id) as { pruned_seq: number };
        if (c.req.valid("query").after < pruned) {
          throw new HTTPException(410, { message: "Those changes were pruned; start from the snapshot" });
        }
        const changes = db
          .prepare(
            `select seq, device_id as deviceId, created_at as createdAt, blob from changes
             where collection_id = ? and seq > ? order by seq limit ?`,
          )
          .all(id, c.req.valid("query").after, PULL_PAGE + 1) as {
          seq: number;
          deviceId: string;
          createdAt: number;
          blob: string;
        }[];
        return c.json({ changes: changes.slice(0, PULL_PAGE), more: changes.length > PULL_PAGE });
      },
    )

    .post(
      "/v1/collections/:id/changes",
      idParam,
      valid("json", z.object({ blob: blob(8_000_000), head: z.number().int().min(0) })),
      (c) => {
        const { id } = c.req.valid("param");
        const { blob, head } = c.req.valid("json");
        ownCollection(c.var.device, id);
        checkLimit(c.var.device.account_id, { storageBytes: blob.length });
        // One statement, so concurrent pushes can't claim the same seq. It only inserts when the
        // log still ends at `head`, so a client never appends on top of changes it hasn't seen.
        // A pruned log may be empty, so its end is at least the pruned watermark.
        const row = db
          .prepare(
            `insert into changes (collection_id, seq, device_id, blob, created_at)
             select ?, max(coalesce(max(ch.seq), 0), c.pruned_seq) + 1, ?, ?, ?
             from collections c left join changes ch on ch.collection_id = c.id where c.id = ?
             having max(coalesce(max(ch.seq), 0), c.pruned_seq) = ?
             returning seq`,
          )
          .get(id, c.var.device.id, blob, now(), id, head) as { seq: number } | undefined;
        if (!row) throw new HTTPException(409, { message: "The collection changed; pull and retry" });
        events.publish(c.var.device.account_id, { type: "changes", from: c.var.device.id, collectionId: id });
        return c.json({ seq: row.seq }, 201);
      },
    )

    .get("/v1/profiles", (c) => {
      const profiles = db
        .prepare("select id, blob, updated_at as updatedAt from profiles where account_id = ? order by updated_at")
        .all(c.var.device.account_id) as { id: string; blob: string; updatedAt: number }[];
      return c.json({ profiles });
    })

    .put("/v1/profiles/:id", idParam, valid("json", z.object({ blob: blob(65_536) })), (c) => {
      const { id } = c.req.valid("param");
      const { changes } = db
        .prepare(
          `insert into profiles (id, account_id, blob, updated_at) values (?, ?, ?, ?)
           on conflict (id) do update set blob = excluded.blob, updated_at = excluded.updated_at
           where profiles.account_id = excluded.account_id`,
        )
        .run(id, c.var.device.account_id, c.req.valid("json").blob, now());
      if (changes === 0) throw new HTTPException(404, { message: "Profile not found" });
      return c.json({ ok: true });
    })

    .delete("/v1/profiles/:id", idParam, (c) => {
      db.prepare("delete from profiles where id = ? and account_id = ?").run(c.req.valid("param").id, c.var.device.account_id);
      return c.json({ ok: true });
    })

    .get("/v1/collections/:id/snapshot", idParam, (c) => {
      const { id } = c.req.valid("param");
      ownCollection(c.var.device, id);
      const snapshot = db.prepare("select seq, blob from snapshots where collection_id = ?").get(id) as
        | { seq: number; blob: string }
        | undefined;
      return c.json({ snapshot: snapshot ?? null });
    })

    /** Stores a newer snapshot. `seq` must be a change the log has reached. */
    .put(
      "/v1/collections/:id/snapshot",
      idParam,
      valid("json", z.object({ seq: z.number().int().positive(), blob: blob(16_000_000) })),
      (c) => {
        const { id } = c.req.valid("param");
        const { seq, blob } = c.req.valid("json");
        ownCollection(c.var.device, id);
        const previous = db.prepare("select length(blob) as size from snapshots where collection_id = ?").get(id) as { size: number } | undefined;
        checkLimit(c.var.device.account_id, { storageBytes: blob.length - (previous?.size ?? 0) });
        const { head } = db
          .prepare(
            `select max(coalesce(max(ch.seq), 0), c.pruned_seq) as head
             from collections c left join changes ch on ch.collection_id = c.id where c.id = ?`,
          )
          .get(id) as { head: number };
        if (seq > head) throw new HTTPException(400, { message: "Snapshot is ahead of the log" });
        db.prepare(
          `insert into snapshots (collection_id, seq, blob, created_at) values (?, ?, ?, ?)
           on conflict (collection_id) do update set seq = excluded.seq, blob = excluded.blob, created_at = excluded.created_at
           where excluded.seq > snapshots.seq`,
        ).run(id, seq, blob, now());
        return c.json({ ok: true });
      },
    )

    .get("/v1/tabs", (c) => {
      const tabs = db
        .prepare(
          `select t.device_id as deviceId, t.blob, t.updated_at as updatedAt from tabs t
           join devices d on d.id = t.device_id where d.account_id = ?`,
        )
        .all(c.var.device.account_id) as { deviceId: string; blob: string; updatedAt: number }[];
      return c.json({ tabs });
    })

    .put("/v1/tabs", valid("json", z.object({ blob: blob(2_000_000) })), (c) => {
      db.prepare(
        `insert into tabs (device_id, blob, updated_at) values (?, ?, ?)
         on conflict (device_id) do update set blob = excluded.blob, updated_at = excluded.updated_at`,
      ).run(c.var.device.id, c.req.valid("json").blob, now());
      events.publish(c.var.device.account_id, { type: "tabs", from: c.var.device.id });
      return c.json({ ok: true });
    })

    /** A tab sent to another device, kept until that device opens it (or 30 days). */
    .post("/v1/sends", valid("json", z.object({ id: z.uuid(), toDeviceId: z.uuid(), blob: blob(16_384) })), (c) => {
      const { id, toDeviceId, blob } = c.req.valid("json");
      const accountId = c.var.device.account_id;
      const target = db.prepare("select 1 from devices where id = ? and account_id = ?").get(toDeviceId, accountId);
      if (!target) throw new HTTPException(404, { message: "Device not found" });
      db.prepare(
        "insert into sends (id, account_id, to_device_id, from_device_id, blob, created_at) values (?, ?, ?, ?, ?, ?)",
      ).run(id, accountId, toDeviceId, c.var.device.id, blob, now());
      events.publish(accountId, { type: "sends", from: c.var.device.id });
      return c.json({ ok: true }, 201);
    })

    .get("/v1/sends", (c) => {
      const sends = db
        .prepare(
          `select id, from_device_id as fromDeviceId, blob, created_at as createdAt from sends
           where to_device_id = ? and created_at > ? order by created_at`,
        )
        .all(c.var.device.id, now() - SEND_TTL_MS) as { id: string; fromDeviceId: string; blob: string; createdAt: number }[];
      return c.json({ sends });
    })

    .delete("/v1/sends/:id", idParam, (c) => {
      db.prepare("delete from sends where id = ? and to_device_id = ?").run(c.req.valid("param").id, c.var.device.id);
      return c.json({ ok: true });
    });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
export type { ServerEvent } from "./events.ts";
