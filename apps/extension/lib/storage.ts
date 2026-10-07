/** Everything the extension persists, in `storage.local`. */
import type { CollectionState, MountMode, MountState, Pause } from "@browserlace/core";
import { storage } from "wxt/utils/storage";

export type Config = {
  serverUrl: string;
  accountId: string;
  deviceId: string;
  token: string;
  deviceName: string;
  /** Base64url account key. Never leaves this device except wrapped in a pairing. */
  accountKey: string;
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

export const collectionStateItem = (id: string) =>
  storage.defineItem<CollectionState>(`local:collection:${id}`, { fallback: { cursor: 0, nodes: {} } });
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
