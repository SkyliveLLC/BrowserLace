/** Everything the extension persists, in `storage.local`. */
import type { CollectionState, DeviceKey, MountMode, MountState, Pause, StoredKeyring } from "@browserlace/core";
import { storage } from "wxt/utils/storage";

export type Config = {
  serverUrl: string;
  accountId: string;
  deviceId: string;
  token: string;
  deviceName: string;
  /** The account's keys, one per epoch. Never leaves this device except wrapped in a pairing. */
  keyring: StoredKeyring;
  /** This device's key pair; other devices grant it new epoch keys. */
  deviceKey: DeviceKey;
};

export type MountConfig = { folderId: string; mode: MountMode; paused?: Pause };

export type CollectionSummary = { id: string; name: string; headSeq: number };

export type Status = {
  lastSyncAt?: number;
  syncing: boolean;
  /** Set when the server no longer accepts this device's token. */
  revoked?: boolean;
  error?: string;
  /** Per-collection failures from the last sync. */
  collectionErrors: Record<string, string>;
};

export const configItem = storage.defineItem<Config | null>("local:config", { fallback: null });
export const mountsItem = storage.defineItem<Record<string, MountConfig>>("local:mounts", { fallback: {} });
export const collectionsItem = storage.defineItem<CollectionSummary[]>("local:collections", { fallback: [] });
export const statusItem = storage.defineItem<Status>("local:status", {
  fallback: { syncing: false, collectionErrors: {} },
});
export const shareTabsItem = storage.defineItem<boolean>("local:shareTabs", { fallback: true });
/** Fingerprint of the last published tab snapshot, to skip redundant uploads. */
export const lastTabsItem = storage.defineItem<string>("local:lastTabs", { fallback: "" });

/** The account's other devices, refreshed on sync, for "send tab" menus. */
export const devicesItem = storage.defineItem<{ id: string; name: string }[]>("local:devices", { fallback: [] });
/** Bumped when another device's tabs change, so an open popup can refresh. */
export const tabsChangedItem = storage.defineItem<number>("local:tabsChanged", { fallback: 0 });

export const collectionStateItem = (id: string) =>
  storage.defineItem<CollectionState>(`local:collection:${id}`, { fallback: { cursor: 0, lastHash: "", nodes: {} } });
export const mountStateItem = (id: string) =>
  storage.defineItem<MountState>(`local:mount:${id}`, { fallback: { links: {}, baseline: {} } });

/** Drops everything stored for a collection on this device. Native bookmarks are left alone. */
export async function forgetCollection(id: string) {
  await Promise.all([collectionStateItem(id).removeValue(), mountStateItem(id).removeValue()]);
  const mounts = await mountsItem.getValue();
  if (mounts[id]) {
    delete mounts[id];
    await mountsItem.setValue(mounts);
  }
}
