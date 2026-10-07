/**
 * Reconciliation between a browser's native bookmark folder and a collection model.
 *
 * Sync is state-based, not event-based: we compare the native folder against the
 * baseline (what it looked like after the last successful sync) to find local edits,
 * then make the native folder match the model. Missed events, crashes and edits made
 * while the extension was off are all handled the same way.
 */
import { generateKeyBetween } from "fractional-indexing";
import { buildTree, ROOT, walk, type Model, type NodeFields, type Op, type TreeNode } from "./model.ts";

/** A native bookmark or folder. Folders have `children` (possibly empty), bookmarks a `url`. */
export type NativeNode = {
  id: string;
  title: string;
  url?: string | undefined;
  children?: NativeNode[] | undefined;
};

/**
 * The browser bookmark API as the reconciler needs it. Implementations hide unsupported
 * node types (e.g. Firefox separators) and translate indexes accordingly.
 */
export interface NativeBookmarks {
  /** The folder with all descendants, or `undefined` if it no longer exists. */
  getTree(folderId: string): Promise<NativeNode | undefined>;
  /** Creates a node and returns it as the browser stored it (URLs may be normalized). */
  create(input: { parentId: string; title: string; url: string | null }): Promise<NativeNode>;
  update(id: string, changes: { title: string; url?: string }): Promise<NativeNode>;
  /**
   * Moves a node so it ends up at `index` among the folder's children (appends when
   * omitted). Callers only move nodes toward the front of a folder or across folders.
   */
  move(id: string, to: { parentId: string; index?: number }): Promise<void>;
  removeTree(id: string): Promise<void>;
}

export type BaselineEntry = {
  parent: string;
  title: string;
  url: string | null;
  /** Position among native siblings. */
  index: number;
  /** The model's position key at the time, to tell whether a sibling moved remotely since. */
  pos: string | undefined;
};

/** Per-mount state persisted between syncs. */
export type MountState = {
  /** Sync id → native id. */
  links: Record<string, string>;
  /** The mounted folder as of the last successful sync, keyed by sync id. */
  baseline: Record<string, BaselineEntry>;
};

export const emptyMountState = (): MountState => ({ links: {}, baseline: {} });

const isFolder = (node: NativeNode) => node.url === undefined;

const JITTER_DIGITS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A key strictly after `a`, and before `b` when the two are still in order. */
function keyBetween(a: string | null, b: string | null): string {
  if (b !== null && (a === null || a < b)) return generateKeyBetween(a, b);
  // Appending: a random suffix keeps two devices appending at once from picking the same key.
  const suffix = Array.from({ length: 2 }, () => JITTER_DIGITS[Math.floor(Math.random() * JITTER_DIGITS.length)]);
  return generateKeyBetween(a, null) + suffix.join("");
}

/** Indexes (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = [];
  values.forEach((v, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i !== -1; i = prev[i]!) keep.add(i);
  return keep;
}

/**
 * Finds local edits since the baseline and expresses them as ops against `model`.
 *
 * Unlinked native nodes are first matched to unlinked model nodes so mounting a folder
 * that already holds the collection's bookmarks (or re-creating bookmarks that were
 * deleted) doesn't duplicate them: folders by title within the same parent, bookmarks by
 * URL, preferring the same parent. Reordering keeps the longest run of siblings that
 * didn't move and only assigns new positions to the rest.
 */
export function diffLocal(
  root: NativeNode,
  state: MountState,
  model: Model,
  newId: () => string = () => crypto.randomUUID(),
): { ops: Op[]; links: Record<string, string>; deletes: number } {
  // Links to native nodes that are gone are dropped up front, so their sync ids can be re-adopted.
  const present = indexNative(root);
  const links = Object.fromEntries(Object.entries(state.links).filter(([, nativeId]) => present.has(nativeId)));
  const syncIdOf = new Map(Object.entries(links).map(([syncId, nativeId]) => [nativeId, syncId]));
  const tree = buildTree(model);
  const visibleChildren = new Map<string, TreeNode[]>([[ROOT, tree.children]]);
  const byUrl = new Map<string, TreeNode[]>();
  for (const { node } of walk(tree)) {
    visibleChildren.set(node.id, node.children);
    if (node.url !== null) byUrl.set(node.url, [...(byUrl.get(node.url) ?? []), node]);
  }
  const adoptable = (folderId: string, native: NativeNode): TreeNode | undefined => {
    const url = native.url ?? null;
    const free = (c: TreeNode) => links[c.id] === undefined && c.url === url;
    const sibling = visibleChildren.get(folderId)?.find((c) => free(c) && (url !== null || c.title === native.title));
    return sibling ?? (url === null ? undefined : byUrl.get(url)?.find(free));
  };

  const ops: Op[] = [];
  const seen = new Set<string>();

  const visit = (folder: NativeNode, folderId: string) => {
    type Child = { native: NativeNode; id: string; set: Partial<NodeFields>; fixed: boolean; baselineIndex?: number };
    const children: Child[] = (folder.children ?? []).map((native) => {
      const url = native.url ?? null;
      const linked = syncIdOf.get(native.id);
      if (linked === undefined) {
        const match = adoptable(folderId, native);
        const id = match?.id ?? newId();
        links[id] = native.id;
        syncIdOf.set(native.id, id);
        return match
          ? { native, id, set: {}, fixed: true }
          : { native, id, set: { parent: folderId, title: native.title, url, deleted: false }, fixed: false };
      }
      const before = state.baseline[linked];
      // Linked but missing from the baseline: a previous sync created it and then failed. Keep the model's version.
      if (!before) return { native, id: linked, set: {}, fixed: true };
      const set: Partial<NodeFields> = {};
      if (before.title !== native.title) set.title = native.title;
      if (before.url !== url) set.url = url;
      if (before.parent !== folderId) set.parent = folderId;
      return { native, id: linked, set, fixed: false, ...(set.parent ? {} : { baselineIndex: before.index }) };
    });

    // Siblings still in their baseline order keep their positions; the rest get new ones.
    const stayed = children.filter((c) => c.baselineIndex !== undefined);
    const inOrder = longestIncreasing(stayed.map((c) => c.baselineIndex!));
    stayed.forEach((c, i) => {
      if (inOrder.has(i) && model.get(c.id)?.pos !== undefined) c.fixed = true;
    });
    // Only siblings that kept their place on both sides are safe to position new keys against.
    const anchor = (c: Child): string | undefined => {
      const node = model.get(c.id);
      if (!c.fixed || node?.pos === undefined || node.parent !== folderId || node.deleted) return undefined;
      const before = state.baseline[c.id];
      return before === undefined || before.pos === node.pos ? node.pos : undefined;
    };
    let prev: string | null = null;
    children.forEach((c, i) => {
      if (c.fixed) {
        prev = anchor(c) ?? prev;
        return;
      }
      const next = children.slice(i + 1).map(anchor).find((key) => key !== undefined);
      c.set.pos = keyBetween(prev, next ?? null);
      prev = c.set.pos;
    });

    for (const c of children) {
      seen.add(c.id);
      if (Object.keys(c.set).length > 0) ops.push({ id: c.id, set: c.set });
      if (isFolder(c.native)) visit(c.native, c.id);
    }
  };
  visit(root, ROOT);

  let deletes = 0;
  for (const id of Object.keys(state.baseline)) {
    if (seen.has(id)) continue;
    ops.push({ id, set: { deleted: true } });
    deletes++;
  }
  return { ops, links, deletes };
}

function indexNative(root: NativeNode) {
  const byId = new Map<string, { node: NativeNode; parentId: string }>();
  const visit = (folder: NativeNode) => {
    for (const child of folder.children ?? []) {
      byId.set(child.id, { node: child, parentId: folder.id });
      visit(child);
    }
  };
  visit(root);
  return byId;
}

/** Native nodes that `applyTree` would delete. Used by the mass-delete guard. */
export function countRemovals(root: NativeNode, links: Record<string, string>, tree: TreeNode): number {
  const kept = new Set<string>();
  for (const { node } of walk(tree)) {
    const nativeId = links[node.id];
    if (nativeId) kept.add(nativeId);
  }
  let removals = 0;
  for (const id of indexNative(root).keys()) if (!kept.has(id)) removals++;
  return removals;
}

/**
 * Makes the native folder `root` match `tree`: updates, moves and creates top-down,
 * fixes sibling order, then removes whatever the model no longer has. Mutates `links`.
 *
 * Nodes the browser refuses (e.g. Firefox rejecting a `javascript:` bookmark) are skipped
 * rather than failing the sync; they stay unlinked, so they're retried next time and never
 * read back as local deletes.
 *
 * Returns the new baseline, built from what was written rather than read back afterwards,
 * so edits the user makes while this runs still show up as local edits next time.
 */
export async function applyTree(
  native: NativeBookmarks,
  root: NativeNode,
  tree: TreeNode,
  links: Record<string, string>,
): Promise<{ skipped: number; baseline: Record<string, BaselineEntry> }> {
  let skipped = 0;
  const baseline: Record<string, BaselineEntry> = {};
  const existing = indexNative(root);
  const kept = new Set<string>();
  const parentOf = new Map([...existing].map(([id, { parentId }]) => [id, parentId]));
  const childrenOf = (folderId: string) =>
    [...parentOf].filter(([, parent]) => parent === folderId).map(([id]) => id);

  const syncFolder = async (folder: TreeNode, folderNativeId: string) => {
    const written: { id: string; pos: string; stored: NativeNode }[] = [];
    for (const child of folder.children) {
      const nativeId = links[child.id];
      const current = nativeId ? existing.get(nativeId)?.node : undefined;
      if (nativeId && current && isFolder(current) === (child.url === null)) {
        let stored = current;
        if (current.title !== child.title || (child.url !== null && current.url !== child.url)) {
          const changes = child.url === null ? { title: child.title } : { title: child.title, url: child.url };
          stored = await native.update(nativeId, changes).catch(() => {
            skipped++;
            return current;
          });
        }
        if (parentOf.get(nativeId) !== folderNativeId) {
          await native.move(nativeId, { parentId: folderNativeId });
          parentOf.delete(nativeId);
          parentOf.set(nativeId, folderNativeId);
        }
        kept.add(nativeId);
        written.push({ id: child.id, pos: child.pos, stored });
      } else {
        const created = await native
          .create({ parentId: folderNativeId, title: child.title, url: child.url })
          .catch(() => undefined);
        if (created === undefined) {
          skipped++;
          delete links[child.id];
          continue;
        }
        links[child.id] = created.id;
        parentOf.set(created.id, folderNativeId);
        kept.add(created.id);
        written.push({ id: child.id, pos: child.pos, stored: created });
      }
    }

    // Native order now: existing children in place, moved/created ones appended. Fix it front to back.
    const order = childrenOf(folderNativeId);
    const desired = folder.children.flatMap((c) => links[c.id] ?? []);
    for (const [i, id] of desired.entries()) {
      if (order[i] === id) continue;
      await native.move(id, { parentId: folderNativeId, index: i });
      order.splice(order.indexOf(id), 1);
      order.splice(i, 0, id);
    }
    written.forEach(({ id, pos, stored }, index) => {
      baseline[id] = { parent: folder.id, title: stored.title, url: stored.url ?? null, index, pos };
    });

    for (const child of folder.children) {
      const nativeId = links[child.id];
      if (child.url === null && nativeId) await syncFolder(child, nativeId);
    }
  };
  await syncFolder(tree, root.id);

  for (const [id, { parentId }] of existing) {
    // Remove only the topmost doomed node of each subtree; its descendants go with it.
    if (!kept.has(id) && (parentId === root.id || kept.has(parentId))) await native.removeTree(id);
  }
  for (const [syncId, nativeId] of Object.entries(links)) {
    if (!kept.has(nativeId)) delete links[syncId];
  }
  return { skipped, baseline };
}

/** Records the native folder, in sync-id space, as the baseline for the next sync. */
export function readBaseline(
  root: NativeNode,
  links: Record<string, string>,
  model: Model,
): Record<string, BaselineEntry> {
  const syncIdOf = new Map(Object.entries(links).map(([syncId, nativeId]) => [nativeId, syncId]));
  const baseline: Record<string, BaselineEntry> = {};
  const visit = (folder: NativeNode, folderId: string) => {
    (folder.children ?? []).forEach((child, index) => {
      const id = syncIdOf.get(child.id);
      if (id === undefined) return;
      baseline[id] = { parent: folderId, title: child.title, url: child.url ?? null, index, pos: model.get(id)?.pos };
      visit(child, id);
    });
  };
  visit(root, ROOT);
  return baseline;
}
