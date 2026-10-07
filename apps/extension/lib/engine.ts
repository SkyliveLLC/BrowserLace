/**
 * The background engine: runs syncs and every state-changing action the UI asks for.
 * UI pages read storage directly but send all writes here (see `call` in messages.ts),
 * so a sync never interleaves with an edit.
 */
import {
  collectionMeta,
  contexts,
  generateAccountKey,
  generatePairingCode,
  importAccountKey,
  normalizePairingCode,
  open,
  openChange,
  pairingLookupId,
  restoreCollection,
  seal,
  syncCollection,
  tabsSnapshot,
  unwrapAccountKey,
  wrapAccountKey,
  type MountMode,
} from "@browserlace/core";
import { browser } from "wxt/browser";
import { ApiError, createApi, transport, unwrap, type Api } from "./api.ts";
import { createMountFolder, hasBookmarksApi, nativeBookmarks } from "./bookmarks.ts";
import { browserName } from "./platform.ts";
import {
  collectionsItem,
  collectionStateItem,
  configItem,
  forgetCollection,
  lastTabsItem,
  mountsItem,
  mountStateItem,
  shareTabsItem,
  statusItem,
  type CollectionSummary,
  type Config,
} from "./storage.ts";
import { captureTabs } from "./tabs.ts";

let queue: Promise<unknown> = Promise.resolve();

/** Runs `task` after everything queued before it. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function session() {
  const config = await configItem.getValue();
  if (!config) throw new Error("BrowserLace isn't set up on this browser yet");
  return { config, api: createApi(config.serverUrl, config.token), key: await importAccountKey(config.accountKey) };
}

async function readCollections(api: Api, key: CryptoKey): Promise<CollectionSummary[]> {
  const { collections } = await unwrap(api.v1.collections.$get());
  return Promise.all(
    collections.map(async ({ id, meta, headSeq }) => {
      const name = await open(key, meta, contexts.meta(id), collectionMeta)
        .then((m) => m.name)
        .catch(() => "(unreadable)");
      return { id, name, headSeq };
    }),
  );
}

async function publishTabs(api: Api, key: CryptoKey, config: Config, force = false) {
  const snapshot = (await shareTabsItem.getValue()) ? await captureTabs() : { v: 1 as const, capturedAt: Date.now(), windows: [] };
  const fingerprint = JSON.stringify(snapshot.windows);
  if (!force && fingerprint === (await lastTabsItem.getValue())) return;
  await unwrap(api.v1.tabs.$put({ json: { blob: await seal(key, snapshot, contexts.tabs(config.deviceId)) } }));
  await lastTabsItem.setValue(fingerprint);
}

/**
 * Syncs every collection: refreshes the list, forgets collections deleted elsewhere,
 * syncs each mount (or just pulls when unmounted), then publishes this browser's tabs.
 */
/** A user's answer to a paused mount, applied on the next sync of that collection. */
type Resolution = { collectionId: string; deletes: "allow" | "discard" };

async function syncAll(resolution?: Resolution) {
  if (!(await configItem.getValue())) return;
  await statusItem.setValue({ ...(await statusItem.getValue()), syncing: true });
  try {
    const { config, api, key } = await session();
    const previous = await collectionsItem.getValue();
    const collections = await readCollections(api, key);
    await collectionsItem.setValue(collections);
    for (const { id } of previous) if (!collections.some((c) => c.id === id)) await forgetCollection(id);

    const mounts = await mountsItem.getValue();
    const collectionErrors: Record<string, string> = {};
    for (const c of collections) {
      const mount = hasBookmarksApi() ? mounts[c.id] : undefined;
      const state = await collectionStateItem(c.id).getValue();
      if (!mount && state.cursor >= c.headSeq) continue;
      try {
        const result = await syncCollection({
          collectionId: c.id,
          key,
          transport: transport(api),
          collection: state,
          mount: mount && {
            native: nativeBookmarks,
            folderId: mount.folderId,
            mode: mount.mode,
            state: await mountStateItem(c.id).getValue(),
          },
          ...(resolution?.collectionId === c.id &&
            (resolution.deletes === "allow" ? { allowDeletes: true } : { discardDeletes: true })),
        });
        await collectionStateItem(c.id).setValue(result.collection);
        if (mount) {
          if (result.mount) await mountStateItem(c.id).setValue(result.mount);
          mounts[c.id] = { folderId: mount.folderId, mode: mount.mode, ...(result.paused ? { paused: result.paused } : {}) };
        }
        if (result.skipped) collectionErrors[c.id] = `${result.skipped} bookmark(s) couldn't be added in this browser`;
        if (result.unreadable) {
          collectionErrors[c.id] = `${result.unreadable} change(s) couldn't be read; another device may need an update`;
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) throw error;
        collectionErrors[c.id] = errorMessage(error);
      }
    }
    await mountsItem.setValue(mounts);
    await publishTabs(api, key, config);
    await statusItem.setValue({ syncing: false, lastSyncAt: Date.now(), collectionErrors });
  } catch (error) {
    const status = await statusItem.getValue();
    await statusItem.setValue({
      ...status,
      syncing: false,
      error: errorMessage(error),
      ...(error instanceof ApiError && error.status === 401 ? { revoked: true } : {}),
    });
  }
}

/** Throws if `folderId` is, contains, or sits inside another collection's mounted folder. */
async function assertNoOverlap(folderId: string, collectionId: string) {
  const ancestors = async (id: string) => {
    const chain: string[] = [];
    for (let cur: string | undefined = id; cur; ) {
      chain.push(cur);
      cur = (await browser.bookmarks.get(cur).catch(() => []))[0]?.parentId;
    }
    return chain;
  };
  const mine = await ancestors(folderId);
  for (const [otherId, other] of Object.entries(await mountsItem.getValue())) {
    if (otherId === collectionId) continue;
    if (mine.includes(other.folderId) || (await ancestors(other.folderId)).includes(folderId)) {
      throw new Error("That folder overlaps a folder another collection is synced to");
    }
  }
}

async function mountCollection(collectionId: string, name: string, folder: string | "new", mode: MountMode) {
  if (!hasBookmarksApi()) throw new Error("This browser doesn't let extensions edit bookmarks");
  // Receive-only replaces the folder's contents, and those bookmarks were never synced, so no history could restore them.
  if (mode === "receive" && folder !== "new" && (await browser.bookmarks.getChildren(folder)).length > 0) {
    throw new Error("Receive-only needs an empty folder. Pick a new folder, or use two-way to merge this one.");
  }
  const folderId = folder === "new" ? await createMountFolder(name) : folder;
  try {
    await assertNoOverlap(folderId, collectionId);
  } catch (error) {
    if (folder === "new") await browser.bookmarks.removeTree(folderId);
    throw error;
  }
  await mountStateItem(collectionId).removeValue();
  await mountsItem.setValue({ ...(await mountsItem.getValue()), [collectionId]: { folderId, mode } });
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
let tabsTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced full sync, used by bookmark events and alarms. */
export function scheduleSync(delayMs = 0) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void exclusive(() => syncAll()), delayMs);
}

/** Debounced tab publish, used by tab events. */
export function schedulePublishTabs(delayMs = 3000) {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(
    () =>
      void exclusive(async () => {
        if (!(await configItem.getValue())) return;
        const { config, api, key } = await session();
        await publishTabs(api, key, config).catch(() => {});
      }),
    delayMs,
  );
}

async function saveConfig(
  input: { serverUrl: string; deviceName: string },
  accountKey: string,
  device: { accountId: string; deviceId: string; token: string },
) {
  await configItem.setValue({ serverUrl: input.serverUrl.replace(/\/+$/, ""), deviceName: input.deviceName, accountKey, ...device });
  await statusItem.setValue({ syncing: false, collectionErrors: {} });
  await syncAll();
}

/** Every action the UI can request. Each takes at most one argument. */
export const handlers = {
  syncNow: () => exclusive(() => syncAll()),

  /** Re-runs a paused collection's sync, letting its pending deletes through. */
  confirmDeletes: (input: { collectionId: string }) =>
    exclusive(() => syncAll({ collectionId: input.collectionId, deletes: "allow" })),

  /** Puts back bookmarks deleted here while a mount was paused, instead of syncing the deletes. */
  discardDeletes: (input: { collectionId: string }) =>
    exclusive(() => syncAll({ collectionId: input.collectionId, deletes: "discard" })),

  createAccount: (input: { serverUrl: string; deviceName: string; signupToken?: string }) =>
    exclusive(async () => {
      const api = createApi(input.serverUrl);
      const device = await unwrap(
        api.v1.accounts.$post({
          json: { name: input.deviceName, browser: browserName(), ...(input.signupToken ? { signupToken: input.signupToken } : {}) },
        }),
      );
      await saveConfig(input, generateAccountKey(), device);
    }),

  joinAccount: (input: { serverUrl: string; code: string; deviceName: string }) =>
    exclusive(async () => {
      if (!normalizePairingCode(input.code)) throw new Error("That doesn't look like a pairing code");
      const api = createApi(input.serverUrl);
      const claimed = await unwrap(
        api.v1.pairings.claim.$post({
          json: { lookupId: await pairingLookupId(input.code), name: input.deviceName, browser: browserName() },
        }),
      );
      const { wrappedKey, ...device } = claimed;
      await saveConfig(input, await unwrapAccountKey(input.code, wrappedKey), device);
    }),

  createPairingCode: async () => {
    const { config, api } = await session();
    const code = generatePairingCode();
    const { expiresAt } = await unwrap(api.v1.pairings.$post({ json: await wrapAccountKey(code, config.accountKey) }));
    return { code, expiresAt, serverUrl: config.serverUrl };
  },

  createCollection: (input: { name: string; folder: string | "new" | null; mode: MountMode }) =>
    exclusive(async () => {
      const { api, key } = await session();
      const id = crypto.randomUUID();
      const meta = await seal(key, { v: 1, name: input.name }, contexts.meta(id));
      await unwrap(api.v1.collections.$post({ json: { id, meta } }));
      if (input.folder) await mountCollection(id, input.name, input.folder, input.mode);
      await syncAll();
    }),

  renameCollection: (input: { collectionId: string; name: string }) =>
    exclusive(async () => {
      const { api, key } = await session();
      const meta = await seal(key, { v: 1, name: input.name }, contexts.meta(input.collectionId));
      await unwrap(api.v1.collections[":id"].$put({ param: { id: input.collectionId }, json: { meta } }));
      await syncAll();
    }),

  deleteCollection: (input: { collectionId: string }) =>
    exclusive(async () => {
      const { api } = await session();
      await unwrap(api.v1.collections[":id"].$delete({ param: { id: input.collectionId } }));
      await forgetCollection(input.collectionId);
      await syncAll();
    }),

  mount: (input: { collectionId: string; folder: string | "new"; mode: MountMode }) =>
    exclusive(async () => {
      const name = (await collectionsItem.getValue()).find((c) => c.id === input.collectionId)?.name ?? "BrowserLace";
      await mountCollection(input.collectionId, name, input.folder, input.mode);
      await syncAll();
    }),

  /** Stops syncing a collection here. Its bookmarks stay in the browser. */
  unmount: (input: { collectionId: string }) =>
    exclusive(async () => {
      const mounts = await mountsItem.getValue();
      delete mounts[input.collectionId];
      await mountsItem.setValue(mounts);
      await mountStateItem(input.collectionId).removeValue();
    }),

  history: async (input: { collectionId: string }) => {
    const { api, key } = await session();
    const [changes, me] = await Promise.all([
      transport(api).pull(input.collectionId, 0),
      unwrap(api.v1.me.$get()),
    ]);
    const names = new Map(me.devices.map((d) => [d.id, d.name]));
    const recent = changes.slice(-50).reverse();
    return Promise.all(
      recent.map(async (change) => {
        const ops = await openChange(key, input.collectionId, change.blob).catch(() => []);
        return {
          seq: change.seq,
          createdAt: change.createdAt,
          device: names.get(change.deviceId) ?? "Removed device",
          ops: ops.length,
          deletes: ops.filter((op) => op.set.deleted === true).length,
        };
      }),
    );
  },

  /** Undoes every change from `beforeSeq` on, as a new change. */
  restore: (input: { collectionId: string; beforeSeq: number }) =>
    exclusive(async () => {
      const { api, key } = await session();
      await restoreCollection({ ...input, key, transport: transport(api) });
      await syncAll({ collectionId: input.collectionId, deletes: "allow" });
    }),

  devicesWithTabs: async () => {
    const { config, api, key } = await session();
    const [me, { tabs }] = await Promise.all([unwrap(api.v1.me.$get()), unwrap(api.v1.tabs.$get())]);
    return Promise.all(
      me.devices.map(async (device) => {
        const row = tabs.find((t) => t.deviceId === device.id);
        const snapshot = row
          ? await open(key, row.blob, contexts.tabs(device.id), tabsSnapshot).catch(() => null)
          : null;
        return { ...device, isThisDevice: device.id === config.deviceId, snapshot };
      }),
    );
  },

  setShareTabs: (input: { enabled: boolean }) =>
    exclusive(async () => {
      await shareTabsItem.setValue(input.enabled);
      const { config, api, key } = await session();
      await publishTabs(api, key, config, true);
    }),

  renameDevice: (input: { name: string }) =>
    exclusive(async () => {
      const { config, api } = await session();
      await unwrap(api.v1.devices.me.$patch({ json: { name: input.name } }));
      await configItem.setValue({ ...config, deviceName: input.name });
    }),

  removeDevice: async (input: { deviceId: string }) => {
    const { api } = await session();
    await unwrap(api.v1.devices[":id"].$delete({ param: { id: input.deviceId } }));
  },

  /** Signs this browser out and wipes local state. Bookmarks stay in the browser. */
  disconnect: () =>
    exclusive(async () => {
      const config = await configItem.getValue();
      if (config) {
        await unwrap(createApi(config.serverUrl, config.token).v1.devices[":id"].$delete({ param: { id: config.deviceId } })).catch(
          () => {},
        );
      }
      await browser.storage.local.clear();
    }),
};

export type Handlers = typeof handlers;
