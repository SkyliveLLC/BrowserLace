import { describe, expect, it } from "vitest";
import { createKeyring, importKeyring, open, seal } from "./crypto.ts";
import { generatePairingCode, normalizePairingCode, pairingLookupId, unwrapKeyring, wrapKeyring } from "./pairing.ts";
import { collectionMeta } from "./payloads.ts";

describe("pairing", () => {
  it("hands the keyring to a device that knows the code", async () => {
    const code = generatePairingCode();
    const keyring = createKeyring();
    const { lookupId, wrappedKey } = await wrapKeyring(code, keyring);

    const typed = code.toLowerCase().replaceAll("-", " ");
    expect(await pairingLookupId(typed)).toBe(lookupId);
    expect(await unwrapKeyring(typed, wrappedKey)).toEqual(keyring);
  });

  it("rejects the wrong code", async () => {
    const { wrappedKey } = await wrapKeyring(generatePairingCode(), createKeyring());
    await expect(unwrapKeyring(generatePairingCode(), wrappedKey)).rejects.toThrow();
  });

  it("normalizes look-alike characters and rejects malformed codes", () => {
    expect(normalizePairingCode("abcd-efgh-jkmn-pqoi")).toBe("ABCDEFGHJKMNPQ01");
    expect(normalizePairingCode("ABCD-EFGH")).toBeNull();
    expect(normalizePairingCode("ABCD-EFGH-JKMN-PQRU")).toBeNull();
  });
});

describe("seal/open", () => {
  it("refuses a blob moved to a different context", async () => {
    const keyring = await importKeyring(createKeyring());
    const blob = await seal(keyring, { v: 1, name: "Work" }, "meta:a");

    expect(await open(keyring, blob, "meta:a", collectionMeta)).toEqual({ v: 1, name: "Work" });
    await expect(open(keyring, blob, "meta:b", collectionMeta)).rejects.toThrow();
  });
});
