/**
 * One sync pass for one collection: pull the log, push local edits from the mounted
 * folder (if any), pull again, then make the folder match the model.
 */
import { hashBlob, open, seal, type Keyring } from "./crypto.ts";
import { applyOps, buildTree, diffModels, type Model, type NodeFields, type Op } from "./model.ts";
import { changePayload, contexts } from "./payloads.ts";
import {
  applyTree,
  countRemovals,
  diffLocal,
  readBaseline,
  type MountState,
  type NativeBookmarks,
  type NativeNode,
} from "./reconcile.ts";

export type Change = { seq: number; deviceId: string; createdAt: number; blob: string };

/** The server as the sync loop sees it. */
export interface Transport {
  /**
   * Appends a change if the log's last seq is still `head`. Returns false when another
   * device pushed first, so the caller can pull, re-diff and retry.
   */
  push(collectionId: string, blob: string, head: number): Promise<boolean>;
  /** All changes with `seq > after`, oldest first. */
  pull(collectionId: string, after: number): Promise<Change[]>;
}

/** The replayed model plus the last applied seq and its hash, persisted per collection. */
export type CollectionState = { cursor: number; lastHash: string; nodes: Record<string, Partial<NodeFields>> };
export const emptyCollectionState = (): CollectionState => ({ cursor: 0, lastHash: "", nodes: {} });

/** The log doesn't chain: the server reordered, replayed or dropped changes. */
export class TamperError extends Error {
  constructor(seq: number) {
    super(`The server sent change ${seq} out of order. Syncing this collection is stopped to protect it.`);
    this.name = "TamperError";
  }
}

export type MountMode = "two-way" | "receive";
export type Mount = { native: NativeBookmarks; folderId: string; mode: MountMode; state: MountState };

/** Why a mount stopped short of applying changes. Resolved by the user. */
export type Pause = { reason: "local-deletes" | "remote-deletes"; count: number } | { reason: "folder-missing" };

export type SyncResult = {
  collection: CollectionState;
  mount?: MountState;
  paused?: Pause;
  /** Ops pushed from local edits. */
  pushed: number;
  /** Nodes this browser refused to create or update. */
  skipped?: number;
  /** Changes that couldn't be decrypted or understood (e.g. from a newer version) and were skipped. */
  unreadable?: number;
};

const MAX_PUSH_ATTEMPTS = 5;

/** Deleting at least this many nodes, and this share of the folder, needs confirmation. */
export const DELETE_GUARD = { min: 10, ratio: 0.25 };
const needsConfirmation = (count: number, total: number) =>
  count >= DELETE_GUARD.min && count > total * DELETE_GUARD.ratio;

export const sealChange = (keyring: Keyring, collectionId: string, prev: string, ops: Op[]) =>
  seal(keyring, { v: 2, prev, ops }, contexts.change(collectionId));

export const openChange = (keyring: Keyring, collectionId: string, blob: string) =>
  open(keyring, blob, contexts.change(collectionId), changePayload);

/**
 * Replays changes into `model`, checking each one names the hash of the change before it.
 * A change that can't be read is skipped rather than blocking the collection forever;
 * every device skips the same one, so they still agree. It still counts for the chain.
 */
async function replay(model: Model, keyring: Keyring, collectionId: string, changes: Change[], lastHash: string) {
  let unreadable = 0;
  for (const change of changes) {
    const payload = await openChange(keyring, collectionId, change.blob).catch(() => null);
    if (payload) {
      if (payload.prev !== lastHash) throw new TamperError(change.seq);
      applyOps(model, payload.ops);
    } else {
      unreadable++;
    }
    lastHash = await hashBlob(change.blob);
  }
  return { unreadable, lastHash };
}

const countNative = (node: NativeNode): number =>
  (node.children ?? []).reduce((sum, child) => sum + 1 + countNative(child), 0);

export async function syncCollection(input: {
  collectionId: string;
  keyring: Keyring;
  transport: Transport;
  collection: CollectionState;
  mount?: Mount | undefined;
  /** Skip the mass-delete guard, after the user confirmed a pause. */
  allowDeletes?: boolean;
  /** Don't push local deletes; the model puts those bookmarks back instead. */
  discardDeletes?: boolean;
}): Promise<SyncResult> {
  const { collectionId, keyring, transport, mount } = input;
  const model: Model = new Map(Object.entries(input.collection.nodes));
  let { cursor, lastHash } = input.collection;
  let unreadable = 0;
  const pull = async () => {
    const changes = await transport.pull(collectionId, cursor);
    const replayed = await replay(model, keyring, collectionId, changes, lastHash);
    unreadable += replayed.unreadable;
    lastHash = replayed.lastHash;
    cursor = changes.at(-1)?.seq ?? cursor;
  };
  const result = (rest: Omit<SyncResult, "collection" | "pushed"> & { pushed?: number } = {}): SyncResult => ({
    collection: { cursor, lastHash, nodes: Object.fromEntries(model) },
    pushed: 0,
    ...(unreadable ? { unreadable } : {}),
    ...rest,
  });

  await pull();
  if (!mount) return result();

  const root = await mount.native.getTree(mount.folderId);
  if (!root) return result({ mount: mount.state, paused: { reason: "folder-missing" } });

  let local = diffLocal(root, mount.state, model);
  let pushed = 0;
  for (let attempt = 1; mount.mode === "two-way"; attempt++) {
    const ops = input.discardDeletes ? local.ops.filter((op) => op.set.deleted !== true) : local.ops;
    if (ops.length === 0) break;
    if (!input.allowDeletes && !input.discardDeletes && needsConfirmation(local.deletes, Object.keys(mount.state.baseline).length)) {
      return result({ mount: mount.state, paused: { reason: "local-deletes", count: local.deletes } });
    }
    const head = cursor;
    const accepted = await transport.push(collectionId, await sealChange(keyring, collectionId, lastHash, ops), head);
    await pull();
    if (accepted) {
      pushed = ops.length;
      break;
    }
    if (attempt === MAX_PUSH_ATTEMPTS) throw new Error("The collection kept changing during sync; will retry");
    // Another device pushed first: diff again so we can adopt what it just created.
    local = diffLocal(root, mount.state, model);
  }

  const tree = buildTree(model);
  const removals = countRemovals(root, local.links, tree);
  if (!input.allowDeletes && needsConfirmation(removals, countNative(root))) {
    // What we pushed is synced; record it so the same edits aren't pushed again while paused.
    const state = pushed > 0 ? { links: local.links, baseline: readBaseline(root, local.links, model) } : mount.state;
    return result({ mount: state, paused: { reason: "remote-deletes", count: removals }, pushed });
  }
  const { skipped, baseline } = await applyTree(mount.native, root, tree, local.links);
  return result({ mount: { links: local.links, baseline }, pushed, ...(skipped ? { skipped } : {}) });
}

/**
 * Restores a collection to how it was before change `beforeSeq`, by pushing a new change
 * that undoes everything since. History stays intact, so a restore can itself be undone.
 */
export async function restoreCollection(input: {
  collectionId: string;
  keyring: Keyring;
  transport: Transport;
  beforeSeq: number;
}): Promise<number> {
  const { collectionId, keyring, transport, beforeSeq } = input;
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    const changes = await transport.pull(collectionId, 0);
    const current: Model = new Map();
    const target: Model = new Map();
    const { lastHash } = await replay(current, keyring, collectionId, changes, "");
    await replay(target, keyring, collectionId, changes.filter((c) => c.seq < beforeSeq), "");
    const ops = diffModels(current, target);
    if (ops.length === 0) return 0;
    const head = changes.at(-1)?.seq ?? 0;
    if (await transport.push(collectionId, await sealChange(keyring, collectionId, lastHash, ops), head)) return ops.length;
  }
  throw new Error("The collection kept changing during restore; try again");
}
