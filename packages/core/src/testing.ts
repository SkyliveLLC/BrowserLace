/** In-memory browser and server used by the sync tests. Not exported from the package. */
import { createKeyring, importKeyring, type Keyring } from "./crypto.ts";
import { emptyMountState, type MountState, type NativeBookmarks, type NativeNode } from "./reconcile.ts";
import { emptyCollectionState, syncCollection, type Change, type CollectionState, type MountMode, type Transport } from "./sync.ts";

type FakeNode = { id: string; title: string; url?: string; parentId: string | null; children: string[] };

export class FakeBrowser implements NativeBookmarks {
  nodes = new Map<string, FakeNode>([["root", { id: "root", title: "", parentId: null, children: [] }]]);
  private nextId = 1;
  /** After this many writes, every write throws. */
  failAfterWrites = Infinity;

  /** Runs after each write, to simulate the user editing while a sync applies changes. */
  afterWrite?: () => Promise<unknown>;

  private write() {
    if (this.failAfterWrites-- <= 0) throw new Error("simulated crash");
    const hook = this.afterWrite;
    this.afterWrite = undefined;
    if (hook) queueMicrotask(() => void hook());
  }

  async getTree(folderId: string): Promise<NativeNode | undefined> {
    const toNative = (node: FakeNode): NativeNode =>
      node.url === undefined
        ? { id: node.id, title: node.title, children: node.children.map((c) => toNative(this.nodes.get(c)!)) }
        : { id: node.id, title: node.title, url: node.url };
    const node = this.nodes.get(folderId);
    return node && toNative(node);
  }

  /** URLs this browser refuses, like Firefox with `javascript:` bookmarks. */
  rejectUrl = (_url: string) => false;

  async create({ parentId, title, url }: { parentId: string; title: string; url: string | null }) {
    this.write();
    if (url !== null && this.rejectUrl(url)) throw new Error(`refused ${url}`);
    const id = `n${this.nextId++}`;
    this.nodes.set(id, { id, title, parentId, children: [], ...(url === null ? {} : { url }) });
    this.nodes.get(parentId)!.children.push(id);
    return (await this.getTree(id))!;
  }

  async update(id: string, changes: { title: string; url?: string }) {
    this.write();
    if (changes.url !== undefined && this.rejectUrl(changes.url)) throw new Error(`refused ${changes.url}`);
    Object.assign(this.nodes.get(id)!, changes);
    return (await this.getTree(id))!;
  }

  async move(id: string, { parentId, index }: { parentId: string; index?: number }) {
    this.write();
    const node = this.nodes.get(id)!;
    const from = this.nodes.get(node.parentId!)!.children;
    from.splice(from.indexOf(id), 1);
    const to = this.nodes.get(parentId)!.children;
    to.splice(index ?? to.length, 0, id);
    node.parentId = parentId;
  }

  async removeTree(id: string) {
    this.write();
    const node = this.nodes.get(id);
    if (!node) return;
    const siblings = this.nodes.get(node.parentId!)!.children;
    siblings.splice(siblings.indexOf(id), 1);
    const drop = (n: FakeNode) => {
      this.nodes.delete(n.id);
      n.children.forEach((c) => drop(this.nodes.get(c)!));
    };
    drop(node);
  }

  /** Adds a bookmark, or a folder when `url` is omitted, as if the user did it. */
  async add(parentId: string, title: string, url?: string) {
    return (await this.create({ parentId, title, url: url ?? null })).id;
  }

  find(title: string): string {
    const node = [...this.nodes.values()].find((n) => n.title === title);
    if (!node) throw new Error(`no node titled ${title}`);
    return node.id;
  }

  /** The folder as indented lines: folders end with `/`, bookmarks show their URL. */
  outline(folderId = "root"): string[] {
    const lines: string[] = [];
    const visit = (id: string, depth: number) => {
      for (const childId of this.nodes.get(id)!.children) {
        const child = this.nodes.get(childId)!;
        lines.push(`${"  ".repeat(depth)}${child.title}${child.url === undefined ? "/" : ` ${child.url}`}`);
        visit(childId, depth + 1);
      }
    };
    visit(folderId, 0);
    return lines;
  }
}

export class FakeServer implements Transport {
  logs = new Map<string, Change[]>();
  /** Runs right before a push lands, to simulate another device racing it. */
  beforePush?: () => Promise<void>;

  async push(collectionId: string, blob: string, head: number) {
    const race = this.beforePush;
    this.beforePush = undefined;
    await race?.();
    const log = this.logs.get(collectionId) ?? [];
    if (log.length !== head) return false;
    log.push({ seq: log.length + 1, deviceId: "test", createdAt: Date.now(), blob });
    this.logs.set(collectionId, log);
    return true;
  }

  async pull(collectionId: string, after: number) {
    return (this.logs.get(collectionId) ?? []).filter((c) => c.seq > after);
  }
}

/** A browser with one mounted collection, mirroring what the extension persists. */
export class Device {
  browser = new FakeBrowser();
  collection: CollectionState = emptyCollectionState();
  mountState: MountState = emptyMountState();

  constructor(
    private server: FakeServer,
    private keyring: Keyring,
    public mode: MountMode = "two-way",
    public folderId = "root",
  ) {}

  async sync(options: { allowDeletes?: boolean; discardDeletes?: boolean } = {}) {
    const result = await syncCollection({
      collectionId: "c1",
      keyring: this.keyring,
      transport: this.server,
      collection: this.collection,
      mount: { native: this.browser, folderId: this.folderId, mode: this.mode, state: this.mountState },
      ...options,
    });
    this.collection = result.collection;
    if (result.mount) this.mountState = result.mount;
    return result;
  }
}

export async function setup() {
  return { server: new FakeServer(), keyring: await importKeyring(createKeyring()) };
}
