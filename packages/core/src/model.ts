/**
 * The collection model: every node ever written to a collection, rebuilt by replaying
 * its changes in server order. Writes are field-level last-writer-wins, so replaying the
 * same log on any device produces the same model.
 */

/** Parent id of a collection's top-level nodes. Each browser maps it to the mounted folder. */
export const ROOT = "root";

export type NodeFields = {
  parent: string;
  /** Fractional index key; siblings sort by (pos, id). */
  pos: string;
  title: string;
  /** `null` marks a folder. */
  url: string | null;
  /** Deletes are sticky: later edits don't revive a node unless they set `deleted: false`. */
  deleted: boolean;
};

/** A field-level write. Creating a node sets every field; edits set only what changed. */
export type Op = { id: string; set: Partial<NodeFields> };

/** Every node ever seen in a collection, deleted ones included, keyed by id. */
export type Model = Map<string, Partial<NodeFields>>;

export type TreeNode = {
  id: string;
  title: string;
  url: string | null;
  pos: string;
  children: TreeNode[];
};

/** Whether making `parent` the parent of `id` would put `id` inside itself. */
function createsCycle(model: Model, id: string, parent: string): boolean {
  const seen = new Set<string>();
  for (let cur: string | undefined = parent; cur !== undefined && cur !== ROOT; cur = model.get(cur)?.parent) {
    if (cur === id || seen.has(cur)) return true;
    seen.add(cur);
  }
  return false;
}

/**
 * Applies ops in order, mutating `model`. A parent change that would create a cycle is
 * dropped (with its `pos`), which every device does identically.
 */
export function applyOps(model: Model, ops: readonly Op[]): void {
  for (const { id, set } of ops) {
    const node = model.get(id) ?? {};
    const fields = { ...set };
    if (fields.parent !== undefined && createsCycle(model, id, fields.parent)) {
      delete fields.parent;
      delete fields.pos;
    }
    model.set(id, { ...node, ...fields });
  }
}

export const compareSiblings = (a: { pos: string; id: string }, b: { pos: string; id: string }) =>
  a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The visible tree: complete, non-deleted nodes whose ancestors are all visible folders
 * reaching ROOT. Anything else (orphans, children of deleted folders) is hidden.
 */
export function buildTree(model: Model): TreeNode {
  const byParent = new Map<string, TreeNode[]>();
  for (const [id, n] of model) {
    if (n.deleted || n.parent === undefined || n.pos === undefined || n.title === undefined || n.url === undefined) {
      continue;
    }
    const siblings = byParent.get(n.parent) ?? [];
    siblings.push({ id, title: n.title, url: n.url, pos: n.pos, children: [] });
    byParent.set(n.parent, siblings);
  }
  const attach = (node: TreeNode): TreeNode => {
    if (node.url === null) node.children = (byParent.get(node.id) ?? []).sort(compareSiblings).map(attach);
    return node;
  };
  return attach({ id: ROOT, title: "", url: null, pos: "", children: [] });
}

/** Every node of a tree below its root, parents before children. */
export function* walk(tree: TreeNode, depth = 0): Generator<{ node: TreeNode; parent: TreeNode; depth: number }> {
  for (const child of tree.children) {
    yield { node: child, parent: tree, depth };
    yield* walk(child, depth + 1);
  }
}

export function countNodes(tree: TreeNode): number {
  let count = 0;
  for (const _ of walk(tree)) count++;
  return count;
}

const FIELDS = ["parent", "pos", "title", "url", "deleted"] as const satisfies readonly (keyof NodeFields)[];

/**
 * Ops that turn `current` into `target`. Used to restore a collection to an earlier
 * point: nodes created since are deleted, everything else gets its old fields back.
 * Ops are ordered shallowest-first in the target tree so restored parents land before
 * their children and no move is dropped as a cycle.
 */
export function diffModels(current: Model, target: Model): Op[] {
  const depth = new Map<string, number>();
  for (const { node, depth: d } of walk(buildTree(target))) depth.set(node.id, d);
  const ops: Op[] = [];
  for (const [id, want] of target) {
    const have = current.get(id) ?? {};
    const set: Partial<NodeFields> = {};
    for (const field of FIELDS) {
      if (want[field] !== undefined && want[field] !== have[field]) Object.assign(set, { [field]: want[field] });
    }
    if (Object.keys(set).length > 0) ops.push({ id, set });
  }
  const unreachable = Number.MAX_SAFE_INTEGER;
  ops.sort((a, b) => (depth.get(a.id) ?? unreachable) - (depth.get(b.id) ?? unreachable));
  for (const [id, have] of current) {
    if (!target.has(id) && !have.deleted) ops.push({ id, set: { deleted: true } });
  }
  return ops;
}
