/**
 * End-to-end encryption. Every device in an account holds the account keyring: one
 * 256-bit key per epoch. A new epoch starts whenever a device is removed (see keys.ts),
 * so removed devices can't read anything written afterwards. The server only ever stores
 * AES-GCM ciphertext. Each blob is bound to its context (e.g. `change:<collectionId>`) via
 * additional data, so the server can't swap blobs around.
 */
import { z } from "zod";

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

const encoder = new TextEncoder();
const IV_BYTES = 12;

/** Encrypts `value` as JSON under a single key. Output: iv ‖ ciphertext. */
async function encrypt(key: CryptoKey, value: unknown, additionalData: string): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(additionalData) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return out;
}

async function decrypt(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>, additionalData: string): Promise<unknown> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: encoder.encode(additionalData) },
    key,
    bytes.subarray(IV_BYTES),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** Seals with a one-off key (pairing codes, grants). Account data uses `seal` with the keyring. */
export const sealWithKey = async (key: CryptoKey, value: unknown, context: string) =>
  toBase64Url(await encrypt(key, value, context));

export const openWithKey = async <S extends z.ZodType>(key: CryptoKey, blob: string, context: string, schema: S) =>
  schema.parse(await decrypt(key, fromBase64Url(blob), context)) as z.output<S>;

/** The keyring as persisted on a device and handed to new devices: epoch → base64url key. */
export const storedKeyring = z.object({
  current: z.number().int().positive(),
  keys: z.record(z.string().regex(/^\d+$/), z.string().length(43)),
});
export type StoredKeyring = z.output<typeof storedKeyring>;

type EpochKeys = { encrypt: CryptoKey; attest: CryptoKey };
/** An imported keyring. `stored` is kept for handing the keyring on (pairing, recovery). */
export type Keyring = { current: number; epochs: ReadonlyMap<number, EpochKeys>; stored: StoredKeyring };

export const generateKey = () => toBase64Url(randomBytes(32));

/** A new account's keyring, starting at epoch 1. */
export const createKeyring = (): StoredKeyring => ({ current: 1, keys: { 1: generateKey() } });

/** Adds keys for other epochs (e.g. from grants), advancing `current` to the newest. */
export function mergeKeyring(base: StoredKeyring, keys: Record<string, string>): StoredKeyring {
  const merged = { ...base.keys, ...keys };
  return { current: Math.max(...Object.keys(merged).map(Number)), keys: merged };
}

export async function importKeyring(stored: StoredKeyring): Promise<Keyring> {
  const epochs = new Map<number, EpochKeys>();
  for (const [epoch, raw] of Object.entries(stored.keys)) {
    const bytes = fromBase64Url(raw);
    // A separate HMAC key for device attestations, derived so the two uses never share a key.
    const material = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    epochs.set(Number(epoch), {
      encrypt: await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]),
      attest: await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("browserlace-attest-v1") },
        material,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      ),
    });
  }
  if (!epochs.has(stored.current)) throw new Error("Keyring is missing its current key");
  return { current: stored.current, epochs, stored };
}

const VERSION = 2;
const HEADER_BYTES = 5;

/** A blob is sealed under an epoch this device hasn't received yet. Retry after the next key refresh. */
export class MissingKeyError extends Error {
  constructor(epoch: number) {
    super(`This device doesn't have the key for epoch ${epoch} yet; it will retry after syncing keys`);
    this.name = "MissingKeyError";
  }
}

function epochKeys(keyring: Keyring, epoch: number): EpochKeys {
  const keys = keyring.epochs.get(epoch);
  if (!keys) throw new MissingKeyError(epoch);
  return keys;
}

/** Encrypts under the current epoch. Output: version ‖ epoch (u32) ‖ iv ‖ ciphertext. */
export async function seal(keyring: Keyring, value: unknown, context: string): Promise<string> {
  const epoch = keyring.current;
  const body = await encrypt(epochKeys(keyring, epoch).encrypt, value, `${context}|${epoch}`);
  const out = new Uint8Array(HEADER_BYTES + body.length);
  out[0] = VERSION;
  new DataView(out.buffer).setUint32(1, epoch);
  out.set(body, HEADER_BYTES);
  return toBase64Url(out);
}

/** Decrypts and validates a blob. Throws if the key, context or shape is wrong. */
export async function open<S extends z.ZodType>(keyring: Keyring, blob: string, context: string, schema: S): Promise<z.output<S>> {
  const bytes = fromBase64Url(blob);
  if (bytes[0] !== VERSION || bytes.length < HEADER_BYTES) throw new Error("Unknown blob format");
  const epoch = new DataView(bytes.buffer).getUint32(1);
  return schema.parse(await decrypt(epochKeys(keyring, epoch).encrypt, bytes.subarray(HEADER_BYTES), `${context}|${epoch}`));
}

/** SHA-256 of a blob as stored, used to chain each change to the one before it. */
export async function hashBlob(blob: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(blob))));
}

/** Proof, under an epoch key, that a public key belongs to a device of this account. */
export async function attest(keyring: Keyring, epoch: number, publicKey: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", epochKeys(keyring, epoch).attest, encoder.encode(`device-key:${publicKey}`));
  return toBase64Url(new Uint8Array(signature));
}

export async function verifyAttestation(keyring: Keyring, epoch: number, publicKey: string, proof: string): Promise<boolean> {
  const keys = keyring.epochs.get(epoch);
  if (!keys) return false;
  return crypto.subtle.verify("HMAC", keys.attest, fromBase64Url(proof), encoder.encode(`device-key:${publicKey}`));
}
