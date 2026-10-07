import { DatabaseSync } from "node:sqlite";

/**
 * Schema migrations, applied in order and tracked with `PRAGMA user_version`.
 * Append new entries; never edit shipped ones.
 */
const migrations = [
  `
  create table accounts (
    id text primary key,
    created_at integer not null
  );
  create table devices (
    id text primary key,
    account_id text not null references accounts(id) on delete cascade,
    name text not null,
    browser text not null,
    token_hash text not null unique,
    created_at integer not null,
    last_seen_at integer not null
  );
  create index devices_account on devices(account_id);
  create table collections (
    id text primary key,
    account_id text not null references accounts(id) on delete cascade,
    meta text not null,
    created_at integer not null
  );
  create index collections_account on collections(account_id);
  create table changes (
    collection_id text not null references collections(id) on delete cascade,
    seq integer not null,
    device_id text not null,
    blob text not null,
    created_at integer not null,
    primary key (collection_id, seq)
  ) without rowid;
  create table tabs (
    device_id text primary key references devices(id) on delete cascade,
    blob text not null,
    updated_at integer not null
  );
  create table pairings (
    lookup_id text primary key,
    account_id text not null references accounts(id) on delete cascade,
    wrapped_key text not null,
    expires_at integer not null
  );
  `,
  // Keyring epochs, device keys, grants and recovery keys (see packages/core/src/keys.ts).
  `
  alter table accounts add column key_epoch integer not null default 1;
  alter table accounts add column rotation_needed integer not null default 0;
  alter table devices add column public_key text;
  alter table devices add column key_proof text;
  alter table devices add column key_proof_epoch integer;
  alter table pairings add column key_epoch integer not null default 1;
  create table recovery (
    account_id text primary key references accounts(id) on delete cascade,
    lookup_id text not null unique,
    public_key text not null,
    key_proof text not null,
    key_proof_epoch integer not null,
    created_at integer not null
  );
  create table grants (
    account_id text not null references accounts(id) on delete cascade,
    recipient_id text not null,
    epoch integer not null,
    blob text not null,
    primary key (account_id, recipient_id, epoch)
  ) without rowid;
  `,
  `
  create table profiles (
    id text primary key,
    account_id text not null references accounts(id) on delete cascade,
    blob text not null,
    updated_at integer not null
  );
  create index profiles_account on profiles(account_id);
  `,
  `
  create table sends (
    id text primary key,
    account_id text not null references accounts(id) on delete cascade,
    to_device_id text not null references devices(id) on delete cascade,
    from_device_id text not null,
    blob text not null,
    created_at integer not null
  );
  create index sends_to on sends(to_device_id);
  `,
  `
  create table snapshots (
    collection_id text primary key references collections(id) on delete cascade,
    seq integer not null,
    blob text not null,
    created_at integer not null
  );
  alter table collections add column pruned_seq integer not null default 0;
  `,
  `
  alter table accounts add column plan text not null default 'free';
  alter table accounts add column stripe_customer_id text;
  alter table accounts add column stripe_subscription_id text;
  alter table accounts add column subscription_status text;
  create unique index accounts_stripe_customer on accounts(stripe_customer_id);
  `,
];

export type Database = DatabaseSync;

/** Opens (or creates) the database and brings its schema up to date. */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
  const { user_version: version } = db.prepare("pragma user_version").get() as { user_version: number };
  for (const [i, sql] of migrations.entries()) {
    if (i < version) continue;
    db.exec("begin");
    db.exec(sql);
    db.exec(`pragma user_version = ${i + 1}`);
    db.exec("commit");
  }
  return db;
}

/** Runs `fn` in a write transaction, rolling back if it throws. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec("begin immediate");
  try {
    const result = fn();
    db.exec("commit");
    return result;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/**
 * Drops changes older than `cutoff` that a snapshot already covers, so the log doesn't
 * grow forever. History (and restore) then starts at the snapshot. Returns how many
 * changes were dropped.
 */
export function pruneHistory(db: Database, cutoff: number): number {
  const candidates = db
    .prepare(
      `select s.collection_id as id, min(s.seq, coalesce(max(ch.seq), 0)) as through
       from snapshots s join changes ch on ch.collection_id = s.collection_id and ch.created_at < ?
       group by s.collection_id`,
    )
    .all(cutoff) as { id: string; through: number }[];
  let dropped = 0;
  for (const { id, through } of candidates) {
    transaction(db, () => {
      dropped += Number(db.prepare("delete from changes where collection_id = ? and seq <= ?").run(id, through).changes);
      db.prepare("update collections set pruned_seq = max(pruned_seq, ?) where id = ?").run(through, id);
    });
  }
  return dropped;
}

/** Deletes pairing codes and sent tabs nobody redeemed in time. */
export function cleanupExpired(db: Database, now: number, sendTtlMs: number) {
  db.prepare("delete from pairings where expires_at <= ?").run(now);
  db.prepare("delete from sends where created_at <= ?").run(now - sendTtlMs);
}
