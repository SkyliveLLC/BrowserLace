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
import { transaction, type Database } from "./db.ts";

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

  /** A `:id` path parameter. Collection and profile ids are client-generated UUIDs. */
  const idParam = valid("param", z.object({ id: z.uuid() }));

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
          .prepare("delete from pairings where lookup_id = ? and expires_at > ? returning account_id, wrapped_key, key_epoch")
          .get(lookupId, now()) as { account_id: string; wrapped_key: string; key_epoch: number } | undefined;
        if (!pairing) throw new HTTPException(404, { message: "Pairing code not found or expired" });
        // The code wraps the keyring as it was; after a rotation the new device would be missing a key.
        const account = db.prepare("select key_epoch from accounts where id = ?").get(pairing.account_id) as { key_epoch: number };
        if (account.key_epoch !== pairing.key_epoch) {
          throw new HTTPException(409, { message: "This pairing code was made before your account's keys changed. Create a new one." });
        }
        return c.json({ ...issueDevice(pairing.account_id, info), wrappedKey: pairing.wrapped_key }, 201);
      },
    )

    .post("/v1/recovery/claim", valid("json", deviceInfo.extend({ lookupId })), (c) => {
      const { lookupId, ...info } = c.req.valid("json");
      const recovery = db.prepare("select account_id from recovery where lookup_id = ?").get(lookupId) as
        | { account_id: string }
        | undefined;
      if (!recovery) throw new HTTPException(404, { message: "No account uses that recovery key" });
      const grants = db
        .prepare("select epoch, blob from grants where account_id = ? and recipient_id = ? order by epoch")
        .all(recovery.account_id, RECOVERY) as { epoch: number; blob: string }[];
      return c.json({ ...issueDevice(recovery.account_id, info), grants }, 201);
    })

    .use("/v1/*", auth)

    .post("/v1/pairings", valid("json", z.object({ lookupId, wrappedKey: blob(65_536), epoch })), (c) => {
      const { lookupId, wrappedKey, epoch } = c.req.valid("json");
      const accountId = c.var.device.account_id;
      const account = db.prepare("select key_epoch from accounts where id = ?").get(accountId) as { key_epoch: number };
      if (account.key_epoch !== epoch) throw new HTTPException(409, { message: "Keys changed; sync and try again" });
      const expiresAt = now() + PAIRING_TTL_MS;
      db.prepare("delete from pairings where expires_at <= ?").run(now());
      db.prepare("insert into pairings (lookup_id, account_id, wrapped_key, expires_at, key_epoch) values (?, ?, ?, ?, ?)").run(
        lookupId,
        accountId,
        wrappedKey,
        expiresAt,
        epoch,
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
      const { id } = c.req.valid("param");
      const accountId = c.var.device.account_id;
      transaction(db, () => {
        const { changes } = db.prepare("delete from devices where id = ? and account_id = ?").run(id, accountId);
        if (changes === 0) throw new HTTPException(404, { message: "Device not found" });
        db.prepare("delete from grants where account_id = ? and recipient_id = ?").run(accountId, id);
        // The removed device knows the current key, so the next device to sync starts a new epoch.
        db.prepare("update accounts set rotation_needed = 1 where id = ?").run(accountId);
      });
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

    .put("/v1/collections/:id", idParam, valid("json", z.object({ meta: blob(4096) })), (c) => {
      const { id } = c.req.valid("param");
      ownCollection(c.var.device, id);
      db.prepare("update collections set meta = ? where id = ?").run(c.req.valid("json").meta, id);
      return c.json({ ok: true });
    })

    .delete("/v1/collections/:id", idParam, (c) => {
      const { id } = c.req.valid("param");
      ownCollection(c.var.device, id);
      db.prepare("delete from collections where id = ?").run(id);
      return c.json({ ok: true });
    })

    .get(
      "/v1/collections/:id/changes",
      idParam,
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
      idParam,
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
