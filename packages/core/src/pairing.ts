/**
 * Device pairing. An existing device shows a one-time code; the new device types it in.
 * Both sides derive two values from the code with HKDF: a lookup id the server uses to
 * find the pairing, and a wrapping key that encrypts the account key. The server sees
 * neither the code nor the account key, and the code's 80 bits make guessing it from the
 * lookup id infeasible.
 */
import { fromBase64Url, open, seal, toBase64Url } from "./crypto.ts";
import { z } from "zod";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const CODE_LENGTH = 16;

/** A fresh code, formatted for display as `XXXX-XXXX-XXXX-XXXX`. */
export function generatePairingCode(): string {
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (b) => ALPHABET[b % 32]);
  return chars.join("").match(/.{4}/g)!.join("-");
}

/** Canonical form of a typed code, forgiving case, separators and look-alikes. `null` if invalid. */
export function normalizePairingCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

async function derive(code: string) {
  const normalized = normalizePairingCode(code);
  if (!normalized) throw new Error("Invalid pairing code");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(normalized), "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  const params = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode("browserlace-pairing-v1"),
    info: new TextEncoder().encode(info),
  });
  const lookupId = toBase64Url(new Uint8Array(await crypto.subtle.deriveBits(params("lookup"), material, 256)));
  const wrapKey = await crypto.subtle.deriveKey(params("wrap"), material, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { lookupId, wrapKey };
}

const wrappedSchema = z.object({ accountKey: z.string() });

/** Run on the existing device: what to upload so the code can be redeemed. */
export async function wrapAccountKey(code: string, accountKey: string) {
  const { lookupId, wrapKey } = await derive(code);
  return { lookupId, wrappedKey: await seal(wrapKey, { accountKey }, `pairing:${lookupId}`) };
}

/** Run on the new device: the lookup id to claim with. */
export const pairingLookupId = async (code: string) => (await derive(code)).lookupId;

/** Run on the new device after claiming: recovers the account key. */
export async function unwrapAccountKey(code: string, wrappedKey: string): Promise<string> {
  const { lookupId, wrapKey } = await derive(code);
  const { accountKey } = await open(wrapKey, wrappedKey, `pairing:${lookupId}`, wrappedSchema);
  if (fromBase64Url(accountKey).length !== 32) throw new Error("Malformed account key");
  return accountKey;
}
