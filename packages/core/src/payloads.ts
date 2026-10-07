/**
 * Shapes of the encrypted payloads. The server never sees these; they're validated after
 * decryption so a buggy or older client can't corrupt another device's state.
 */
import { z } from "zod";
import type { Op } from "./model.ts";

// Extension pages forbid eval, which zod otherwise probes for to compile validators.
z.config({ jitless: true });

const nodeFields = z
  .object({
    parent: z.string(),
    pos: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    deleted: z.boolean(),
  })
  .partial();

/**
 * One batch of ops, written by one device in one sync. `prev` is the hash of the change
 * before it in the log (empty for the first), so a server can't reorder or replay changes.
 */
export const changePayload = z.object({
  v: z.literal(2),
  prev: z.string(),
  ops: z.array(z.object({ id: z.string(), set: nodeFields })),
}) satisfies z.ZodType<{ v: 2; prev: string; ops: Op[] }>;

export const collectionMeta = z.object({ v: z.literal(1), name: z.string().min(1) });
export type CollectionMeta = z.output<typeof collectionMeta>;

export const tabsSnapshot = z.object({
  v: z.literal(1),
  capturedAt: z.number(),
  windows: z.array(
    z.object({
      focused: z.boolean(),
      tabs: z.array(z.object({ title: z.string(), url: z.string(), pinned: z.boolean(), active: z.boolean() })),
    }),
  ),
});
export type TabsSnapshot = z.output<typeof tabsSnapshot>;

/** Additional-data contexts that bind each blob to where it's stored. */
export const contexts = {
  change: (collectionId: string) => `change:${collectionId}`,
  meta: (collectionId: string) => `meta:${collectionId}`,
  tabs: (deviceId: string) => `tabs:${deviceId}`,
};
