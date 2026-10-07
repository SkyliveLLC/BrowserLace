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
