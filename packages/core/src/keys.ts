/**
 * Getting keys to the right devices without trusting the server.
 *
 * Each device has an X25519 key pair. When a device is removed, the next device to sync
 * starts a new epoch: it generates a key and wraps it (a "grant") for every remaining
 * device's public key, plus the recovery key's. The server stores grants it can't open.
 *
 * A server could list a device of its own, so a grant is only made for a public key that
 * carries an attestation: an HMAC under an epoch key, which only account devices have.
 */
import { z } from "zod";
import {
  attest,
  fromBase64Url,
  generateKey,
  importKeyring,
  mergeKeyring,
  openWithKey,
  randomBytes,
  sealWithKey,
  storedKeyring,
  toBase64Url,
  verifyAttestation,
  type Keyring,
  type StoredKeyring,
} from "./crypto.ts";
import { ALPHABET, normalizeBase32 } from "./pairing.ts";

const encoder = new TextEncoder();

/** Grants and attestations are addressed to a device id, or to this for the recovery key. */
export const RECOVERY_RECIPIENT = "recovery";

/** A device's key pair. The private key is a JWK so it can live in extension storage. */
export type DeviceKey = { publicKey: string; privateKey: JsonWebKey };

const exportPublic = async (key: CryptoKey) => toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));

export async function generateDeviceKey(): Promise<DeviceKey> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { publicKey: await exportPublic(pair.publicKey), privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey) };
}

export const importPrivateKey = (jwk: JsonWebKey) => crypto.subtle.importKey("jwk", jwk, { name: "X25519" }, false, ["deriveBits"]);

/** The AES key shared between an ephemeral key and a recipient, bound to both public keys. */
async function sharedKey(privateKey: CryptoKey, peerPublic: string, ephemeralPublic: string, recipientPublic: string) {
  const peer = await crypto.subtle.importKey("raw", fromBase64Url(peerPublic), { name: "X25519" }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(`${ephemeralPublic}.${recipientPublic}`),
      info: encoder.encode("browserlace-grant-v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * What a grant carries. A new epoch's key comes with a proof under the previous epoch, so
 * a recipient knows an account device made it, not the server. A recovery key's first
 * grant carries the whole keyring with a proof under a key derived from the recovery key.
 */
export const grantPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("epoch"), epoch: z.number().int().min(2), key: z.string().length(43), proof: z.string() }),
  z.object({ kind: z.literal("keyring"), keyring: storedKeyring, proof: z.string() }),
]);
export type GrantPayload = z.output<typeof grantPayload>;

export const grantContext = (recipientId: string, epoch: number) => `grant:${recipientId}:${epoch}`;

/** Encrypts a grant to a recipient's public key. Output: `<ephemeral public key>.<ciphertext>`. */
export async function sealGrant(recipientPublic: string, payload: GrantPayload, context: string): Promise<string> {
  const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephemeralPublic = await exportPublic(ephemeral.publicKey);
  const key = await sharedKey(ephemeral.privateKey, recipientPublic, ephemeralPublic, recipientPublic);
  return `${ephemeralPublic}.${await sealWithKey(key, payload, context)}`;
}

export type Recipient = { id: string; publicKey: string; privateKey: CryptoKey };

export async function openGrant(recipient: Recipient, grant: string, context: string): Promise<GrantPayload> {
  const [ephemeralPublic, sealed] = grant.split(".");
  if (!ephemeralPublic || !sealed) throw new Error("Malformed grant");
  const key = await sharedKey(recipient.privateKey, ephemeralPublic, ephemeralPublic, recipient.publicKey);
  return openWithKey(key, sealed, context, grantPayload);
}

const epochStatement = (epoch: number, key: string) => `epoch:${epoch}:${key}`;

/**
 * Adds the keys in `grants` (oldest epoch first) to `stored`. Throws if a grant isn't
 * proven to come from the account, which means the server tried to plant a key.
 * `recoveryMac` verifies keyring grants; only a browser recovering with the key has it.
 */
export async function acceptGrants(
  stored: StoredKeyring | null,
  recipient: Recipient,
  grants: { epoch: number; blob: string }[],
  recoveryMac?: CryptoKey,
): Promise<StoredKeyring> {
  let current = stored;
  for (const grant of [...grants].sort((a, b) => a.epoch - b.epoch)) {
    if (current?.keys[grant.epoch]) continue;
    const payload = await openGrant(recipient, grant.blob, grantContext(recipient.id, grant.epoch));
    if (payload.kind === "keyring") {
      const valid =
        recoveryMac !== undefined &&
        (await crypto.subtle.verify("HMAC", recoveryMac, fromBase64Url(payload.proof), encoder.encode(JSON.stringify(payload.keyring))));
      if (!valid) throw new Error("A key from the server couldn't be verified");
      current = current ? mergeKeyring(current, payload.keyring.keys) : payload.keyring;
      continue;
    }
    const keyring = current && (await importKeyring(current));
    const valid =
      keyring !== null &&
      payload.epoch === grant.epoch &&
      (await verifyAttestation(keyring, payload.epoch - 1, epochStatement(payload.epoch, payload.key), payload.proof));
    if (!valid || !current) throw new Error("A key from the server couldn't be verified");
    current = mergeKeyring(current, { [payload.epoch]: payload.key });
  }
  if (!current) throw new Error("No keys were found for this device");
  return current;
}

/** A device or the recovery key, as the server lists it, with its attestation. */
export type KeyHolder = { id: string; publicKey: string; proof: string; proofEpoch: number };

/**
 * Starts a new epoch: a fresh key, granted to every holder whose attestation checks out,
 * and re-attested under the new epoch. Holders that fail the check (planted by the
 * server) are left out and returned in `excluded`.
 */
export async function rotateKeys(keyring: Keyring, holders: KeyHolder[]) {
  const epoch = keyring.current + 1;
  const key = generateKey();
  const next = await importKeyring(mergeKeyring(keyring.stored, { [epoch]: key }));
  const proof = await attest(keyring, keyring.current, epochStatement(epoch, key));
  const trusted: KeyHolder[] = [];
  const excluded: string[] = [];
  for (const holder of holders) {
    const ok = await verifyAttestation(keyring, holder.proofEpoch, holder.publicKey, holder.proof);
    if (ok) trusted.push(holder);
    else excluded.push(holder.id);
  }
  return {
    epoch,
    keyring: next,
    excluded,
    grants: await Promise.all(
      trusted.map(async (h) => ({
        recipientId: h.id,
        blob: await sealGrant(h.publicKey, { kind: "epoch", epoch, key, proof }, grantContext(h.id, epoch)),
      })),
    ),
    attestations: await Promise.all(trusted.map(async (h) => ({ recipientId: h.id, proof: await attest(next, epoch, h.publicKey) }))),
  };
}

// --- Recovery keys --------------------------------------------------------------------

/**
 * A recovery key is 32 random bytes, written out in Crockford base32. It acts as a
 * device that lives on paper: its bytes are an X25519 private key that receives grants
 * like any device, and a lookup id derived from it lets a new browser find the account.
 */
const RECOVERY_BYTES = 32;
const RECOVERY_CHARS = Math.ceil((RECOVERY_BYTES * 8) / 5);
// PKCS#8 wrapper for a raw X25519 private key (RFC 8410).
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

/** A fresh recovery key, formatted for display in groups of four. */
export function generateRecoveryKey(): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of randomBytes(RECOVERY_BYTES)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

function decodeRecoveryKey(input: string): Uint8Array<ArrayBuffer> | null {
  const text = normalizeBase32(input);
  if (text.length !== RECOVERY_CHARS || ![...text].every((c) => ALPHABET.includes(c))) return null;
  const bytes = new Uint8Array(RECOVERY_BYTES);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const char of text) {
    value = ((value << 5) | ALPHABET.indexOf(char)) & 0xfff;
    bits += 5;
    if (bits >= 8 && i < RECOVERY_BYTES) {
      bytes[i++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return bytes;
}

export const isRecoveryKey = (input: string) => decodeRecoveryKey(input) !== null;

/** What a recovery key stands for: its lookup id and its key pair. */
export async function recoveryIdentity(recoveryKey: string) {
  const bytes = decodeRecoveryKey(recoveryKey);
  if (!bytes) throw new Error("That doesn't look like a recovery key");
  const pkcs8 = new Uint8Array(PKCS8_X25519.length + RECOVERY_BYTES);
  pkcs8.set(PKCS8_X25519);
  pkcs8.set(bytes, PKCS8_X25519.length);
  const extractable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", extractable);
  const material = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits", "deriveKey"]);
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode(info) });
  const lookup = await crypto.subtle.deriveBits(hkdf("browserlace-recovery-lookup-v1"), material, 256);
  return {
    id: RECOVERY_RECIPIENT,
    lookupId: toBase64Url(new Uint8Array(lookup)),
    publicKey: jwk.x!,
    privateKey: await importPrivateKey(jwk),
    mac: await crypto.subtle.deriveKey(hkdf("browserlace-recovery-mac-v1"), material, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]),
  };
}

/** What a device uploads to set up a recovery key: its lookup id, attested public key and a grant of the keyring. */
export async function recoverySetup(keyring: Keyring, recoveryKey: string) {
  const identity = await recoveryIdentity(recoveryKey);
  const mac = await crypto.subtle.sign("HMAC", identity.mac, encoder.encode(JSON.stringify(keyring.stored)));
  const payload: GrantPayload = { kind: "keyring", keyring: keyring.stored, proof: toBase64Url(new Uint8Array(mac)) };
  return {
    lookupId: identity.lookupId,
    publicKey: identity.publicKey,
    proof: await attest(keyring, keyring.current, identity.publicKey),
    proofEpoch: keyring.current,
    epoch: keyring.current,
    grant: await sealGrant(identity.publicKey, payload, grantContext(RECOVERY_RECIPIENT, keyring.current)),
  };
}

