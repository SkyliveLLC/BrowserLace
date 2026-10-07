/**
 * The background engine: runs syncs and every state-changing action the UI asks for.
 * UI pages read storage directly but send all writes here (see `call` in messages.ts),
 * so a sync never interleaves with an edit.
 */
import {
  acceptGrants,
  attest,
  collectionMeta,
  contexts,
  createKeyring,
  generateDeviceKey,
  generatePairingCode,
  generateRecoveryKey,
  importKeyring,
  importPrivateKey,
  normalizePairingCode,
  open,
  openChange,
  pairingLink,
  pairingLookupId,
  parsePairingInput,
  profilePayload,
  recoveryIdentity,
  recoverySetup,
  restoreCollection,
  rotateKeys,
  seal,
  syncCollection,
  tabsSnapshot,
  unwrapKeyring,
  wrapKeyring,
  type Keyring,
  type MountMode,
  type StoredKeyring,
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

/**
 * The signed-in config, API client and keyring. Pass `refresh` before sealing anything,
 * so a rotation another device started is picked up first and nothing new goes out
 * under a key a removed device has.
 */
async function session({ refresh = false } = {}) {
  const config = await configItem.getValue();
  if (!config) throw new Error("BrowserLace isn't set up on this browser yet");
  const api = createApi(config.serverUrl, config.token);
  const keyring = refresh ? await refreshKeys(api, config) : await importKeyring(config.keyring);
  // refreshKeys may have saved a newer keyring.
  return { config: (await configItem.getValue()) ?? config, api, keyring };
}

async function readCollections(api: Api, keyring: Keyring): Promise<CollectionSummary[]> {
  const { collections } = await unwrap(api.v1.collections.$get());
  return Promise.all(
    collections.map(async ({ id, meta, headSeq }) => {
      const name = await open(keyring, meta, contexts.meta(id), collectionMeta)
        .then((m) => m.name)
        .catch(() => "(unreadable)");
      return { id, name, headSeq };
    }),
  );
}

/**
 * Brings this device's keys up to date: takes keys other devices granted it, registers
 * its own public key if the server doesn't have it, and starts a new epoch when the
 * server says a device was removed (or `rotate` is set, so a removal rotates even if a
 * server never raises the flag). Returns the keyring to sync with.
 */
async function refreshKeys(api: Api, config: Config, { rotate = false } = {}): Promise<Keyring> {
  const me = { id: config.deviceId, publicKey: config.deviceKey.publicKey, privateKey: await importPrivateKey(config.deviceKey.privateKey) };
  const save = async (stored: StoredKeyring) => {
    config = { ...config, keyring: stored };
    await configItem.setValue(config);
  };
  for (let attempt = 1; ; attempt++) {
    let state = await unwrap(api.v1.keys.$get());
    const accepted = await acceptGrants(config.keyring, me, state.grants);
    if (accepted !== config.keyring) await save(accepted);
    const keyring = await importKeyring(config.keyring);

    if (!state.holders.some((h) => h.id === config.deviceId)) {
      const proof = await attest(keyring, keyring.current, me.publicKey);
      await unwrap(api.v1.devices.me.key.$put({ json: { publicKey: me.publicKey, proof, proofEpoch: keyring.current } }));
      state = await unwrap(api.v1.keys.$get());
    }
    if (keyring.current < state.epoch) {
      throw new Error("Waiting for one of your other devices to share new encryption keys. Open BrowserLace on a device that synced recently.");
    }
    if (!state.rotationNeeded && !rotate) return keyring;

    const rotation = await rotateKeys(keyring, state.holders);
    const metas = await Promise.all(
      (await unwrap(api.v1.collections.$get())).collections.map(async ({ id, meta }) => {
        const name = await open(keyring, meta, contexts.meta(id), collectionMeta).catch(() => null);
        return name && { collectionId: id, previous: meta, meta: await seal(rotation.keyring, name, contexts.meta(id)) };
      }),
    );
    try {
      await unwrap(
        api.v1.keys.$post({
          json: { epoch: rotation.epoch, grants: rotation.grants, attestations: rotation.attestations, metas: metas.filter((m) => m !== null) },
        }),
      );
    } catch (error) {
      // Another device started the epoch first, or a device registered meanwhile: look again.
      if (error instanceof ApiError && error.status === 409 && attempt < 3) {
        rotate = false;
        continue;
      }
      throw error;
    }
    await save(rotation.keyring.stored);
    return rotation.keyring;
  }
}

async function publishTabs(api: Api, keyring: Keyring, config: Config, force = false) {
  const snapshot = (await shareTabsItem.getValue()) ? await captureTabs() : { v: 1 as const, capturedAt: Date.now(), windows: [] };
  // Includes the epoch so a new key republishes the snapshot under it.
  const fingerprint = `${keyring.current}:${JSON.stringify(snapshot.windows)}`;
  if (!force && fingerprint === (await lastTabsItem.getValue())) return;
  await unwrap(api.v1.tabs.$put({ json: { blob: await seal(keyring, snapshot, contexts.tabs(config.deviceId)) } }));
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
    const { config, api, keyring } = await session({ refresh: true });
    const previous = await collectionsItem.getValue();
    const collections = await readCollections(api, keyring);
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
          keyring,
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
    await publishTabs(api, keyring, config);
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
        const { config, api, keyring } = await session({ refresh: true });
        await publishTabs(api, keyring, config).catch(() => {});
      }),
    delayMs,
  );
}

async function saveConfig(
  input: { serverUrl: string; deviceName: string },
  keyring: StoredKeyring,
  device: { accountId: string; deviceId: string; token: string },
) {
  await configItem.setValue({
    serverUrl: input.serverUrl.replace(/\/+$/, ""),
    deviceName: input.deviceName,
    keyring,
    deviceKey: await generateDeviceKey(),
    ...device,
  });
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
      await saveConfig(input, createKeyring(), device);
    }),

  /** Joins with a pairing code, or a pairing link (which also carries the server URL). */
  joinAccount: (input: { serverUrl: string; code: string; deviceName: string }) =>
    exclusive(async () => {
      const { code, serverUrl = input.serverUrl } = parsePairingInput(input.code);
      if (!normalizePairingCode(code)) throw new Error("That doesn't look like a pairing code or link");
      const api = createApi(serverUrl);
      const claimed = await unwrap(
        api.v1.pairings.claim.$post({
          json: { lookupId: await pairingLookupId(code), name: input.deviceName, browser: browserName() },
        }),
      );
      const { wrappedKey, ...device } = claimed;
      await saveConfig({ ...input, serverUrl }, await unwrapKeyring(code, wrappedKey), device);
    }),

  /** Signs this browser in with a recovery key, when no other device is left to pair with. */
  recoverAccount: (input: { serverUrl: string; recoveryKey: string; deviceName: string }) =>
    exclusive(async () => {
      const identity = await recoveryIdentity(input.recoveryKey);
      const api = createApi(input.serverUrl);
      const { grants, ...device } = await unwrap(
        api.v1.recovery.claim.$post({ json: { lookupId: identity.lookupId, name: input.deviceName, browser: browserName() } }),
      );
      await saveConfig(input, await acceptGrants(null, identity, grants, identity.mac), device);
    }),

  createPairingCode: () =>
    exclusive(async () => {
      const { config, api, keyring } = await session({ refresh: true });
      const code = generatePairingCode();
      const wrapped = await wrapKeyring(code, keyring.stored);
      const { expiresAt } = await unwrap(api.v1.pairings.$post({ json: { ...wrapped, epoch: keyring.current } }));
      return { code, expiresAt, serverUrl: config.serverUrl, link: pairingLink(config.serverUrl, code) };
    }),

  /** Creates (or replaces) the account's recovery key and returns it, to be shown once. */
  createRecoveryKey: () =>
    exclusive(async () => {
      const { api, keyring } = await session({ refresh: true });
      const recoveryKey = generateRecoveryKey();
      const { lookupId, publicKey, proof, proofEpoch, epoch, grant } = await recoverySetup(keyring, recoveryKey);
      await unwrap(api.v1.recovery.$put({ json: { lookupId, publicKey, proof, proofEpoch, epoch, grant } }));
      return recoveryKey;
    }),

  recoveryStatus: async () => {
    const { api } = await session();
    return (await unwrap(api.v1.recovery.$get())).recovery;
  },

  createCollection: (input: { name: string; folder: string | "new" | null; mode: MountMode }) =>
    exclusive(async () => {
      const { api, keyring } = await session({ refresh: true });
      const id = crypto.randomUUID();
      const meta = await seal(keyring, { v: 1, name: input.name }, contexts.meta(id));
      await unwrap(api.v1.collections.$post({ json: { id, meta } }));
      if (input.folder) await mountCollection(id, input.name, input.folder, input.mode);
      await syncAll();
    }),

  renameCollection: (input: { collectionId: string; name: string }) =>
    exclusive(async () => {
      const { api, keyring } = await session({ refresh: true });
      const meta = await seal(keyring, { v: 1, name: input.name }, contexts.meta(input.collectionId));
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

  profiles: async () => {
    const { api, keyring } = await session();
    const { profiles } = await unwrap(api.v1.profiles.$get());
    const opened = await Promise.all(
      profiles.map(({ id, blob }) =>
        open(keyring, blob, contexts.profile(id), profilePayload).then(
          (profile) => ({ id, ...profile }),
          () => null,
        ),
      ),
    );
    return opened.filter((p) => p !== null);
  },

  /** Saves this browser's mounts as a named profile other browsers can apply. */
  saveProfile: (input: { name: string }) =>
    exclusive(async () => {
      const { api, keyring } = await session({ refresh: true });
      const rules = await Promise.all(
        Object.entries(await mountsItem.getValue()).map(async ([collectionId, mount]) => ({
          collectionId,
          mode: mount.mode,
          folderTitle: (await browser.bookmarks.get(mount.folderId).catch(() => []))[0]?.title ?? "BrowserLace",
        })),
      );
      if (rules.length === 0) throw new Error("Sync at least one collection to a folder first");
      const id = crypto.randomUUID();
      const blob = await seal(keyring, { v: 1, name: input.name, rules }, contexts.profile(id));
      await unwrap(api.v1.profiles[":id"].$put({ param: { id }, json: { blob } }));
    }),

  /** Mounts every collection in a profile that isn't synced here yet, each into a new folder. */
  applyProfile: (input: { profileId: string }) =>
    exclusive(async () => {
      const { api, keyring } = await session();
      const row = (await unwrap(api.v1.profiles.$get())).profiles.find((p) => p.id === input.profileId);
      if (!row) throw new Error("That profile was deleted");
      const profile = await open(keyring, row.blob, contexts.profile(row.id), profilePayload);
      const collections = await collectionsItem.getValue();
      const mounts = await mountsItem.getValue();
      for (const rule of profile.rules) {
        if (mounts[rule.collectionId] || !collections.some((c) => c.id === rule.collectionId)) continue;
        await mountCollection(rule.collectionId, rule.folderTitle, "new", rule.mode);
      }
      await syncAll();
    }),

  deleteProfile: async (input: { profileId: string }) => {
    const { api } = await session();
    await unwrap(api.v1.profiles[":id"].$delete({ param: { id: input.profileId } }));
  },

  history: async (input: { collectionId: string }) => {
    const { api, keyring } = await session();
    const [changes, me] = await Promise.all([
      transport(api).pull(input.collectionId, 0),
      unwrap(api.v1.me.$get()),
    ]);
    const names = new Map(me.devices.map((d) => [d.id, d.name]));
    const recent = changes.slice(-50).reverse();
    return Promise.all(
      recent.map(async (change) => {
        const ops = await openChange(keyring, input.collectionId, change.blob)
          .then((payload) => payload.ops)
          .catch(() => []);
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
      const { api, keyring } = await session({ refresh: true });
      await restoreCollection({ ...input, keyring, transport: transport(api) });
      await syncAll({ collectionId: input.collectionId, deletes: "allow" });
    }),

  devicesWithTabs: async () => {
    const { config, api, keyring } = await session();
    const [me, { tabs }] = await Promise.all([unwrap(api.v1.me.$get()), unwrap(api.v1.tabs.$get())]);
    return Promise.all(
      me.devices.map(async (device) => {
        const row = tabs.find((t) => t.deviceId === device.id);
        const snapshot = row
          ? await open(keyring, row.blob, contexts.tabs(device.id), tabsSnapshot).catch(() => null)
          : null;
        return { ...device, isThisDevice: device.id === config.deviceId, snapshot };
      }),
    );
  },

  setShareTabs: (input: { enabled: boolean }) =>
    exclusive(async () => {
      await shareTabsItem.setValue(input.enabled);
      const { config, api, keyring } = await session({ refresh: true });
      await publishTabs(api, keyring, config, true);
    }),

  renameDevice: (input: { name: string }) =>
    exclusive(async () => {
      const { config, api } = await session();
      await unwrap(api.v1.devices.me.$patch({ json: { name: input.name } }));
      await configItem.setValue({ ...config, deviceName: input.name });
    }),

  /** Removes a device, then syncs so the account moves to a key the removed device doesn't have. */
  removeDevice: (input: { deviceId: string }) =>
    exclusive(async () => {
      const { config, api } = await session();
      await unwrap(api.v1.devices[":id"].$delete({ param: { id: input.deviceId } }));
      await refreshKeys(api, config, { rotate: true });
      await syncAll();
    }),

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
