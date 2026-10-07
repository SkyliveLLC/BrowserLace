/**
 * Device pairing. An existing device shows a one-time code; the new device types it in.
 * Both sides derive two values from the code with HKDF: a lookup id the server uses to
 * find the pairing, and a wrapping key that encrypts the account keyring. The server sees
 * neither the code nor the keys, and the code's 80 bits make guessing it from the lookup
 * id infeasible.
 */
import { openWithKey, sealWithKey, storedKeyring, toBase64Url, type StoredKeyring } from "./crypto.ts";

/** Crockford base32: no I, L, O, U. */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;

/** Uppercases and strips separators, mapping look-alikes (O → 0, I/L → 1). */
export const normalizeBase32 = (input: string) =>
  input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");

/** A fresh code, formatted for display as `XXXX-XXXX-XXXX-XXXX`. */
export function generatePairingCode(): string {
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (b) => ALPHABET[b % 32]);
  return chars.join("").match(/.{4}/g)!.join("-");
}

/** Canonical form of a typed code, forgiving case, separators and look-alikes. `null` if invalid. */
export function normalizePairingCode(input: string): string | null {
  const code = normalizeBase32(input);
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/**
 * A pairing code with its server, as one string to paste or scan (QR) on the new device:
 * `browserlace://pair?server=<url>&code=<code>`.
 */
export const pairingLink = (serverUrl: string, code: string) =>
  `browserlace://pair?${new URLSearchParams({ server: serverUrl, code })}`;

/** Reads what was typed into the join form: a bare code, or a pairing link. */
export function parsePairingInput(input: string): { code: string; serverUrl?: string } {
  const text = input.trim();
  if (!text.startsWith("browserlace://")) return { code: text };
  const params = new URL(text).searchParams;
  const server = params.get("server");
  return { code: params.get("code") ?? "", ...(server ? { serverUrl: server } : {}) };
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

/** Run on the existing device: what to upload so the code can be redeemed. */
export async function wrapKeyring(code: string, keyring: StoredKeyring) {
  const { lookupId, wrapKey } = await derive(code);
  return { lookupId, wrappedKey: await sealWithKey(wrapKey, keyring, `pairing:${lookupId}`) };
}

/** Run on the new device: the lookup id to claim with. */
export const pairingLookupId = async (code: string) => (await derive(code)).lookupId;

/** Run on the new device after claiming: recovers the account keyring. */
export async function unwrapKeyring(code: string, wrappedKey: string): Promise<StoredKeyring> {
  const { lookupId, wrapKey } = await derive(code);
  return openWithKey(wrapKey, wrappedKey, `pairing:${lookupId}`, storedKeyring);
}
