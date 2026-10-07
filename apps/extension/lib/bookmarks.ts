/** The browser bookmarks API adapted to the core reconciler. Unavailable in Safari. */
import type { NativeBookmarks, NativeNode } from "@browserlace/core";
import { browser, type Browser } from "wxt/browser";

type BookmarkNode = Browser.bookmarks.BookmarkTreeNode;

export const hasBookmarksApi = () => typeof browser.bookmarks?.getTree === "function";

/** Firefox separators and smart folders (`place:` queries) don't exist elsewhere, so they aren't synced. */
const isSyncable = (node: BookmarkNode) =>
  (node as { type?: string }).type !== "separator" && !node.url?.startsWith("place:");

const toNative = (node: BookmarkNode): NativeNode =>
  node.url === undefined
    ? { id: node.id, title: node.title, children: (node.children ?? []).filter(isSyncable).map(toNative) }
    : { id: node.id, title: node.title, url: node.url };

export const nativeBookmarks: NativeBookmarks = {
  async getTree(folderId) {
    try {
      const [node] = await browser.bookmarks.getSubTree(folderId);
      return node && toNative(node);
    } catch {
      return undefined;
    }
  },

  async create({ parentId, title, url }) {
    return toNative(await browser.bookmarks.create({ parentId, title, ...(url === null ? {} : { url }) }));
  },

  async update(id, changes) {
    return toNative(await browser.bookmarks.update(id, changes));
  },

  async move(id, { parentId, index }) {
    if (index === undefined) {
      await browser.bookmarks.move(id, { parentId });
      return;
    }
    // `index` counts only syncable siblings; translate it to the browser's real index.
    const children = await browser.bookmarks.getChildren(parentId);
    const target = children.filter(isSyncable)[index];
    await browser.bookmarks.move(id, { parentId, index: target?.index ?? children.length });
  },

  async removeTree(id) {
    await browser.bookmarks.removeTree(id).catch(() => {
      // Already gone, e.g. removed by the user mid-sync.
    });
  },
};

export type FolderOption = { id: string; path: string };

/** Every folder a collection can be mounted on, with a readable path for pickers. */
export async function listFolders(): Promise<FolderOption[]> {
  const [root] = await browser.bookmarks.getTree();
  const folders: FolderOption[] = [];
  const visit = (node: BookmarkNode, path: string[]) => {
    for (const child of node.children ?? []) {
      if (child.url !== undefined || child.unmodifiable) continue;
      const childPath = [...path, child.title || "(untitled)"];
      folders.push({ id: child.id, path: childPath.join(" / ") });
      visit(child, childPath);
    }
  };
  if (root) visit(root, []);
  return folders;
}

/** Creates the folder a new mount lives in, under "Other Bookmarks" where the browser has one. */
export async function createMountFolder(name: string): Promise<string> {
  const [root] = await browser.bookmarks.getTree();
  const tops = root?.children ?? [];
  // `folderType` exists from Chrome 134; before that "Other bookmarks" is id "2". Firefox calls it unfiled.
  const other =
    tops.find((n) => (n as { folderType?: string }).folderType === "other") ??
    tops.find((n) => n.id === "2" || n.id === "unfiled_____") ??
    tops[0];
  if (!other) throw new Error("No bookmark folder to create the mount in");
  return (await browser.bookmarks.create({ parentId: other.id, title: name })).id;
}

export async function folderPath(folderId: string): Promise<string | undefined> {
  const parts: string[] = [];
  try {
    for (let id: string | undefined = folderId; id; ) {
      const [node]: BookmarkNode[] = await browser.bookmarks.get(id);
      if (!node?.parentId) break;
      parts.unshift(node.title);
      id = node.parentId;
    }
  } catch {
    return undefined;
  }
  return parts.join(" / ");
}
