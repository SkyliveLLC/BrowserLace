/**
 * The sync server. It authenticates devices, orders each collection's changes and stores
 * encrypted blobs. It never sees bookmark content, tab URLs or collection names.
 *
 * The extension imports `AppType` for a typed client (`hc<AppType>`).
 */
import { zValidator } from "@hono/zod-validator";
import { Hono, type ValidationTargets } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.ts";

/** Validates a request part, answering 400 itself so error shapes stay out of the client types. */
const valid = <Target extends keyof ValidationTargets, Schema extends z.ZodType>(target: Target, schema: Schema) =>
  zValidator(target, schema, (result) => {
    if (!result.success) throw new HTTPException(400, { message: z.prettifyError(result.error) });
  });

/** Base64url ciphertext as produced by the core package's `seal`. */
const blob = (maxLength: number) => z.string().min(1).max(maxLength).regex(/^[\w-]+$/);
const deviceInfo = z.object({ name: z.string().trim().min(1).max(80), browser: z.string().trim().min(1).max(40) });
const lookupId = z.string().length(43).regex(/^[\w-]+$/);

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PULL_PAGE = 500;

type Device = { id: string; account_id: string };
type Env = { Variables: { device: Device } };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type AppOptions = {
  db: Database;
  /** When set, creating an account requires this token. Leave unset for open signup. */
  signupToken?: string | undefined;
  now?: () => number;
};

export function createApp({ db, signupToken, now = Date.now }: AppOptions) {
  const issueDevice = (accountId: string, info: z.output<typeof deviceInfo>) => {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    db.prepare(
      "insert into devices (id, account_id, name, browser, token_hash, created_at, last_seen_at) values (?, ?, ?, ?, ?, ?, ?)",
    ).run(id, accountId, info.name, info.browser, hashToken(token), now(), now());
    return { accountId, deviceId: id, token };
  };

  const auth = createMiddleware<Env>(async (c, next) => {
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const device = token
      ? (db.prepare("select id, account_id from devices where token_hash = ?").get(hashToken(token)) as Device | undefined)
      : undefined;
    if (!device) throw new HTTPException(401, { message: "Unknown or revoked device" });
    db.prepare("update devices set last_seen_at = ? where id = ?").run(now(), device.id);
    c.set("device", device);
    await next();
  });

  /** Throws 404 unless the collection belongs to the caller's account. */
  const ownCollection = (device: Device, collectionId: string) => {
    const row = db.prepare("select id from collections where id = ? and account_id = ?").get(collectionId, device.account_id);
    if (!row) throw new HTTPException(404, { message: "Collection not found" });
  };

  const collectionParam = valid("param", z.object({ id: z.uuid() }));

  const app = new Hono<Env>()
    // Clients authenticate with bearer tokens, never cookies, so any origin may call us.
    .use(cors())
    .use(bodyLimit({ maxSize: 8 * 1024 * 1024 }))
    .onError((err, c) => {
      if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: "Internal error" }, 500);
    })
    .get("/healthz", (c) => c.json({ ok: true }))

    .post("/v1/accounts", valid("json", deviceInfo.extend({ signupToken: z.string().optional() })), (c) => {
      const { signupToken: given, ...info } = c.req.valid("json");
      if (signupToken && given !== signupToken) throw new HTTPException(403, { message: "Signup token required" });
      const accountId = randomUUID();
      db.prepare("insert into accounts (id, created_at) values (?, ?)").run(accountId, now());
      return c.json(issueDevice(accountId, info), 201);
    })

    .post(
      "/v1/pairings/claim",
      valid("json", deviceInfo.extend({ lookupId })),
      (c) => {
        const { lookupId, ...info } = c.req.valid("json");
        const pairing = db
          .prepare("delete from pairings where lookup_id = ? and expires_at > ? returning account_id, wrapped_key")
          .get(lookupId, now()) as { account_id: string; wrapped_key: string } | undefined;
        if (!pairing) throw new HTTPException(404, { message: "Pairing code not found or expired" });
        return c.json({ ...issueDevice(pairing.account_id, info), wrappedKey: pairing.wrapped_key }, 201);
      },
    )

    .use("/v1/*", auth)

    .post("/v1/pairings", valid("json", z.object({ lookupId, wrappedKey: blob(1024) })), (c) => {
      const { lookupId, wrappedKey } = c.req.valid("json");
      const expiresAt = now() + PAIRING_TTL_MS;
      db.prepare("delete from pairings where expires_at <= ?").run(now());
      db.prepare("insert into pairings (lookup_id, account_id, wrapped_key, expires_at) values (?, ?, ?, ?)").run(
        lookupId,
        c.var.device.account_id,
        wrappedKey,
        expiresAt,
      );
      return c.json({ expiresAt }, 201);
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
      const { changes } = db
        .prepare("delete from devices where id = ? and account_id = ?")
        .run(c.req.valid("param").id, c.var.device.account_id);
      if (changes === 0) throw new HTTPException(404, { message: "Device not found" });
      return c.json({ ok: true });
    })

    .get("/v1/collections", (c) => {
      const collections = db
        .prepare(
          `select c.id, c.meta, c.created_at as createdAt, coalesce(max(ch.seq), 0) as headSeq
           from collections c left join changes ch on ch.collection_id = c.id
           where c.account_id = ? group by c.id order by c.created_at`,
        )
        .all(c.var.device.account_id) as { id: string; meta: string; createdAt: number; headSeq: number }[];
      return c.json({ collections });
    })

    .post("/v1/collections", valid("json", z.object({ id: z.uuid(), meta: blob(4096) })), (c) => {
      const { id, meta } = c.req.valid("json");
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
      return c.json({ id }, 201);
    })

    .put("/v1/collections/:id", collectionParam, valid("json", z.object({ meta: blob(4096) })), (c) => {
      const { id } = c.req.valid("param");
      ownCollection(c.var.device, id);
      db.prepare("update collections set meta = ? where id = ?").run(c.req.valid("json").meta, id);
      return c.json({ ok: true });
    })

    .delete("/v1/collections/:id", collectionParam, (c) => {
      const { id } = c.req.valid("param");
      ownCollection(c.var.device, id);
      db.prepare("delete from collections where id = ?").run(id);
      return c.json({ ok: true });
    })

    .get(
      "/v1/collections/:id/changes",
      collectionParam,
      valid("query", z.object({ after: z.coerce.number().int().min(0).default(0) })),
      (c) => {
        const { id } = c.req.valid("param");
        ownCollection(c.var.device, id);
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
      collectionParam,
      valid("json", z.object({ blob: blob(8_000_000), head: z.number().int().min(0) })),
      (c) => {
        const { id } = c.req.valid("param");
        const { blob, head } = c.req.valid("json");
        ownCollection(c.var.device, id);
        // One statement, so concurrent pushes can't claim the same seq. It only inserts when the
        // log still ends at `head`, so a client never appends on top of changes it hasn't seen.
        const row = db
          .prepare(
            `insert into changes (collection_id, seq, device_id, blob, created_at)
             select ?, coalesce(max(seq), 0) + 1, ?, ?, ? from changes where collection_id = ?
             having coalesce(max(seq), 0) = ?
             returning seq`,
          )
          .get(id, c.var.device.id, blob, now(), id, head) as { seq: number } | undefined;
        if (!row) throw new HTTPException(409, { message: "The collection changed; pull and retry" });
        return c.json({ seq: row.seq }, 201);
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
      return c.json({ ok: true });
    });

  return app;
}

export type AppType = ReturnType<typeof createApp>;
