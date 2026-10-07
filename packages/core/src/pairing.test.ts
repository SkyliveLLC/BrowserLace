import { describe, expect, it } from "vitest";
import { generateAccountKey, importAccountKey, open, seal } from "./crypto.ts";
import { generatePairingCode, normalizePairingCode, pairingLookupId, unwrapAccountKey, wrapAccountKey } from "./pairing.ts";
import { collectionMeta } from "./payloads.ts";

describe("pairing", () => {
  it("hands the account key to a device that knows the code", async () => {
    const code = generatePairingCode();
    const accountKey = generateAccountKey();
    const { lookupId, wrappedKey } = await wrapAccountKey(code, accountKey);

    const typed = code.toLowerCase().replaceAll("-", " ");
    expect(await pairingLookupId(typed)).toBe(lookupId);
    expect(await unwrapAccountKey(typed, wrappedKey)).toBe(accountKey);
  });

  it("rejects the wrong code", async () => {
    const { wrappedKey } = await wrapAccountKey(generatePairingCode(), generateAccountKey());
    await expect(unwrapAccountKey(generatePairingCode(), wrappedKey)).rejects.toThrow();
  });

  it("normalizes look-alike characters and rejects malformed codes", () => {
    expect(normalizePairingCode("abcd-efgh-jkmn-pqoi")).toBe("ABCDEFGHJKMNPQ01");
    expect(normalizePairingCode("ABCD-EFGH")).toBeNull();
    expect(normalizePairingCode("ABCD-EFGH-JKMN-PQRU")).toBeNull();
  });
});

describe("seal/open", () => {
  it("refuses a blob moved to a different context", async () => {
    const key = await importAccountKey(generateAccountKey());
    const blob = await seal(key, { v: 1, name: "Work" }, "meta:a");

    expect(await open(key, blob, "meta:a", collectionMeta)).toEqual({ v: 1, name: "Work" });
    await expect(open(key, blob, "meta:b", collectionMeta)).rejects.toThrow();
  });
});
