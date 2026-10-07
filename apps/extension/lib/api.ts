/** Typed client for the sync server, built from the server's own route types. */
import { PrunedError, type Transport } from "@browserlace/core";
import type { AppType } from "@browserlace/server";
import { hc } from "hono/client";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const createApi = (serverUrl: string, token?: string) =>
  hc<AppType>(serverUrl.replace(/\/+$/, ""), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

export type Api = ReturnType<typeof createApi>;

type Response = { ok: boolean; status: number; json(): Promise<unknown> };

/** Awaits a request and returns its JSON body, throwing `ApiError` for non-2xx responses. */
export async function unwrap<R extends Response>(request: Promise<R>): Promise<Awaited<ReturnType<R["json"]>>> {
  const res = await request.catch((error: unknown) => {
    throw new ApiError(0, `Can't reach the server (${error instanceof Error ? error.message : String(error)})`);
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<Awaited<ReturnType<R["json"]>>>;
}

export const transport = (api: Api): Transport => ({
  async push(collectionId, blob, head) {
    try {
      await unwrap(api.v1.collections[":id"].changes.$post({ param: { id: collectionId }, json: { blob, head } }));
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return false;
      throw error;
    }
  },
  async pull(collectionId, after) {
    const changes = [];
    for (let more = true; more; ) {
      const page = await unwrap(
        api.v1.collections[":id"].changes.$get({ param: { id: collectionId }, query: { after: String(after) } }),
      ).catch((error: unknown) => {
        throw error instanceof ApiError && error.status === 410 ? new PrunedError() : error;
      });
      changes.push(...page.changes);
      after = page.changes.at(-1)?.seq ?? after;
      more = page.more;
    }
    return changes;
  },
  async snapshot(collectionId) {
    return (await unwrap(api.v1.collections[":id"].snapshot.$get({ param: { id: collectionId } }))).snapshot;
  },
});
