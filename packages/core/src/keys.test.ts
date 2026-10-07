import { describe, expect, it } from "vitest";
import { attest, createKeyring, generateKey, importKeyring, open, seal, type Keyring } from "./crypto.ts";
import {
  acceptGrants,
  generateDeviceKey,
  generateRecoveryKey,
  grantContext,
  importPrivateKey,
  isRecoveryKey,
  recoveryIdentity,
  recoverySetup,
  rotateKeys,
  sealGrant,
  type KeyHolder,
} from "./keys.ts";
import { collectionMeta } from "./payloads.ts";

/** A device with its key pair and an attestation under the keyring's current epoch. */
async function device(id: string, keyring: Keyring) {
  const key = await generateDeviceKey();
  const recipient = { id, publicKey: key.publicKey, privateKey: await importPrivateKey(key.privateKey) };
  const holder: KeyHolder = { id, publicKey: key.publicKey, proof: await attest(keyring, keyring.current, key.publicKey), proofEpoch: keyring.current };
  return { recipient, holder };
}

describe("key rotation", () => {
  it("gives the new key to remaining devices only, and leaves out planted ones", async () => {
    const epoch1 = await importKeyring(createKeyring());
    const b = await device("b", epoch1);
    const planted: KeyHolder = { ...(await device("planted", epoch1)).holder, proof: "AAAA" };

    const rotation = await rotateKeys(epoch1, [b.holder, planted]);
    expect(rotation.epoch).toBe(2);
    expect(rotation.excluded).toEqual(["planted"]);
    expect(rotation.grants.map((g) => g.recipientId)).toEqual(["b"]);

    const bKeyring = await importKeyring(await acceptGrants(epoch1.stored, b.recipient, [{ epoch: 2, blob: rotation.grants[0]!.blob }]));
    const blob = await seal(rotation.keyring, { v: 1, name: "After" }, "meta:x");
    expect(await open(bKeyring, blob, "meta:x", collectionMeta)).toEqual({ v: 1, name: "After" });
    // A removed device still has epoch 1, which can't open epoch 2.
    await expect(open(epoch1, blob, "meta:x", collectionMeta)).rejects.toThrow();
  });

  it("refuses a key the server made up", async () => {
    const epoch1 = await importKeyring(createKeyring());
    const b = await device("b", epoch1);
    const forged = await sealGrant(b.recipient.publicKey, { kind: "epoch", epoch: 2, key: generateKey(), proof: "AAAA" }, grantContext("b", 2));

    await expect(acceptGrants(epoch1.stored, b.recipient, [{ epoch: 2, blob: forged }])).rejects.toThrow(/verified/);
  });
});

describe("recovery keys", () => {
  it("recovers the keyring, including epochs added after it was made", async () => {
    const epoch1 = await importKeyring(createKeyring());
    const recoveryKey = generateRecoveryKey();
    const setup = await recoverySetup(epoch1, recoveryKey);
    const rotation = await rotateKeys(epoch1, [{ id: "recovery", publicKey: setup.publicKey, proof: setup.proof, proofEpoch: setup.proofEpoch }]);

    const typed = recoveryKey.toLowerCase().replaceAll("-", "");
    const identity = await recoveryIdentity(typed);
    expect(identity.lookupId).toBe(setup.lookupId);
    const grants = [{ epoch: 1, blob: setup.grant }, { epoch: 2, blob: rotation.grants[0]!.blob }];
    expect(await acceptGrants(null, identity, grants, identity.mac)).toEqual(rotation.keyring.stored);
  });

  it("refuses a keyring grant the recovery key didn't authorize", async () => {
    const identity = await recoveryIdentity(generateRecoveryKey());
    const fake = await sealGrant(identity.publicKey, { kind: "keyring", keyring: createKeyring(), proof: "AAAA" }, grantContext("recovery", 1));

    await expect(acceptGrants(null, identity, [{ epoch: 1, blob: fake }], identity.mac)).rejects.toThrow(/verified/);
  });

  it("validates the format", () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/);
    expect(isRecoveryKey(key)).toBe(true);
    expect(isRecoveryKey(key.slice(0, -1))).toBe(false);
  });
});
