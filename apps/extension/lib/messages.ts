/** Typed request/response channel from UI pages to the background engine. */
import { browser } from "wxt/browser";
import type { Handlers } from "./engine.ts";

export type Request = { [K in keyof Handlers]: { type: K; input: Parameters<Handlers[K]>[0] } }[keyof Handlers];
export type Reply = { ok: true; value: unknown } | { ok: false; error: string };

/** Asks the background to run a handler and returns its result, rethrowing its error. */
export async function call<K extends keyof Handlers>(
  type: K,
  ...[input]: Parameters<Handlers[K]>
): Promise<Awaited<ReturnType<Handlers[K]>>> {
  const reply = (await browser.runtime.sendMessage({ type, input })) as Reply | undefined;
  if (!reply) throw new Error("BrowserLace's background worker didn't respond");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as Awaited<ReturnType<Handlers[K]>>;
}
