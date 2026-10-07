/**
 * End-to-end encryption. Every device in an account shares one 256-bit account key; the
 * server only ever stores AES-GCM ciphertext. Each blob is bound to its context (e.g.
 * `change:<collectionId>`) via additional data, so the server can't swap blobs around.
 */
import type { z } from "zod";

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

export const generateAccountKey = () => toBase64Url(randomBytes(32));

/** Imports a base64url account key (as stored on the device) for sealing and opening blobs. */
export const importAccountKey = (key: string) =>
  crypto.subtle.importKey("raw", fromBase64Url(key), "AES-GCM", false, ["encrypt", "decrypt"]);

const encoder = new TextEncoder();
const IV_BYTES = 12;

export async function seal(key: CryptoKey, value: unknown, context: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ciphertext), IV_BYTES);
  return toBase64Url(out);
}

/** Decrypts and validates a blob. Throws if the key, context or shape is wrong. */
export async function open<S extends z.ZodType>(key: CryptoKey, blob: string, context: string, schema: S): Promise<z.output<S>> {
  const bytes = fromBase64Url(blob);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: encoder.encode(context) },
    key,
    bytes.subarray(IV_BYTES),
  );
  return schema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
}
