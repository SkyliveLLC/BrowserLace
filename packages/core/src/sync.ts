/**
 * One sync pass for one collection: pull the log, push local edits from the mounted
 * folder (if any), pull again, then make the folder match the model.
 */
import { hashBlob, MissingKeyError, open, seal, type Keyring } from "./crypto.ts";
import { applyOps, buildTree, diffModels, type Model, type NodeFields, type Op } from "./model.ts";
import { changePayload, contexts, snapshotPayload } from "./payloads.ts";
import {
  applyTree,
  countRemovals,
  diffLocal,
  modelBaseline,
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
  /**
   * All changes with `seq > after`, oldest first. Throws `PrunedError` if the server has
   * dropped some of them (they're older than its history and covered by a snapshot).
   */
  pull(collectionId: string, after: number): Promise<Change[]>;
  /** The collection's latest snapshot, if any device has uploaded one. */
  snapshot(collectionId: string): Promise<{ blob: string } | null>;
}

/** The server no longer has every change after the requested point; start from its snapshot. */
export class PrunedError extends Error {
  constructor() {
    super("The server no longer keeps that much history");
    this.name = "PrunedError";
  }
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

/**
 * `two-way` merges both ways. `receive` only applies the collection to the folder.
 * `send` makes the collection match the folder and never writes to the folder.
 */
export type MountMode = "two-way" | "receive" | "send";
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
 * A change sealed under a key this device hasn't received yet throws `MissingKeyError`,
 * which fails the whole sync without saving anything, so the change is retried later.
 */
async function replay(model: Model, keyring: Keyring, collectionId: string, changes: Change[], lastHash: string) {
  let unreadable = 0;
  for (const change of changes) {
    // A key we don't have yet isn't "unreadable": stop, so the change is retried rather than skipped.
    const payload = await openChange(keyring, collectionId, change.blob).catch((error: unknown) => {
      if (error instanceof MissingKeyError) throw error;
      return null;
    });
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

export const sealSnapshot = (keyring: Keyring, collectionId: string, state: CollectionState) =>
  seal(keyring, { v: 1, ...state }, contexts.snapshot(collectionId));

/** The collection as of its latest snapshot, or empty when there's none. */
async function snapshotState(keyring: Keyring, transport: Transport, collectionId: string): Promise<CollectionState> {
  const snapshot = await transport.snapshot(collectionId);
  if (!snapshot) return emptyCollectionState();
  const { cursor, lastHash, nodes } = await open(keyring, snapshot.blob, contexts.snapshot(collectionId), snapshotPayload);
  return { cursor, lastHash, nodes };
}

/**
 * Changes after `state` (starting from the snapshot instead when the server has pruned
 * what `state` needs). Returns the state to replay them onto.
 */
async function changesSince(keyring: Keyring, transport: Transport, collectionId: string, state: CollectionState) {
  try {
    return { base: state, changes: await transport.pull(collectionId, state.cursor) };
  } catch (error) {
    if (!(error instanceof PrunedError)) throw error;
    const base = await snapshotState(keyring, transport, collectionId);
    return { base, changes: await transport.pull(collectionId, base.cursor) };
  }
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
  // A new device starts from the latest snapshot instead of replaying the whole log.
  const start = input.collection.cursor === 0 ? await snapshotState(keyring, transport, collectionId) : input.collection;
  const model: Model = new Map(Object.entries(start.nodes));
  let { cursor, lastHash } = start;
  let unreadable = 0;
  const pull = async () => {
    const { base, changes } = await changesSince(keyring, transport, collectionId, { cursor, lastHash, nodes: {} });
    if (base.cursor !== cursor) {
      // Offline for longer than the server keeps history: continue from its snapshot.
      model.clear();
      for (const [id, node] of Object.entries(base.nodes)) model.set(id, node);
      ({ cursor, lastHash } = base);
    }
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

  // Send-only diffs against the model itself, so other devices' edits are reverted too.
  // Links to nodes the model no longer shows (deleted elsewhere) are dropped, so they're re-created.
  const diff = () => {
    if (mount.mode !== "send") return diffLocal(root, mount.state, model);
    const baseline = modelBaseline(buildTree(model));
    const links = Object.fromEntries(Object.entries(mount.state.links).filter(([id]) => baseline[id]));
    return diffLocal(root, { links, baseline }, model);
  };
  let local = diff();
  let pushed = 0;
  for (let attempt = 1; mount.mode !== "receive"; attempt++) {
    const ops = input.discardDeletes ? local.ops.filter((op) => op.set.deleted !== true) : local.ops;
    if (ops.length === 0) break;
    const total = Object.keys(mount.mode === "send" ? modelBaseline(buildTree(model)) : mount.state.baseline).length;
    if (!input.allowDeletes && !input.discardDeletes && needsConfirmation(local.deletes, total)) {
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
    local = diff();
  }

  if (mount.mode === "send") {
    return result({ mount: { links: local.links, baseline: readBaseline(root, local.links, model) }, pushed });
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
 * Points older than the server's history (before its snapshot) can't be restored.
 */
export async function restoreCollection(input: {
  collectionId: string;
  keyring: Keyring;
  transport: Transport;
  beforeSeq: number;
}): Promise<number> {
  const { collectionId, keyring, transport, beforeSeq } = input;
  for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
    const { base, changes } = await changesSince(keyring, transport, collectionId, emptyCollectionState());
    if (beforeSeq <= base.cursor) throw new Error("That point is older than the history the server keeps");
    const current: Model = new Map(Object.entries(base.nodes));
    const target: Model = new Map(Object.entries(base.nodes));
    const { lastHash } = await replay(current, keyring, collectionId, changes, base.lastHash);
    await replay(target, keyring, collectionId, changes.filter((c) => c.seq < beforeSeq), base.lastHash);
    const ops = diffModels(current, target);
    if (ops.length === 0) return 0;
    const head = changes.at(-1)?.seq ?? base.cursor;
    if (await transport.push(collectionId, await sealChange(keyring, collectionId, lastHash, ops), head)) return ops.length;
  }
  throw new Error("The collection kept changing during restore; try again");
}
