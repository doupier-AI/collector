import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCredentialStore, type CredentialEncryption } from "@collector/desktop-capture/dist/credential-store.js";

function encryption(available: () => boolean): CredentialEncryption {
  return {
    isEncryptionAvailable: available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
}

test("credential store handles encrypted and plaintext availability combinations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let available = true;
  const store = new FileCredentialStore(root, encryption(() => available));

  await store.set("profile-one", "secret-one");
  assert.equal(await store.get("profile-one"), "secret-one");
  assert.equal(JSON.parse(await readFile(join(root, "profile-one.json"), "utf8")).encrypted, true);

  available = false;
  assert.equal(await store.get("profile-one"), undefined, "encrypted credentials cannot be read without safeStorage");
  await store.set("profile-two", "secret-two");
  assert.equal(await store.get("profile-two"), "secret-two");
  assert.equal(JSON.parse(await readFile(join(root, "profile-two.json"), "utf8")).encrypted, false);

  available = true;
  assert.equal(await store.get("profile-two"), "secret-two");
  assert.equal(JSON.parse(await readFile(join(root, "profile-two.json"), "utf8")).encrypted, true, "plaintext fallback is upgraded when encryption returns");
});

test("credential store falls back when availability or encryption throws", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "collector-credentials-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unavailable: CredentialEncryption = {
    isEncryptionAvailable: () => { throw new Error("availability failed"); },
    encryptString: () => { throw new Error("not reached"); },
    decryptString: () => { throw new Error("not reached"); },
  };
  const store = new FileCredentialStore(root, unavailable);
  await store.set("profile-fallback", "fallback-secret");
  assert.equal(await store.get("profile-fallback"), "fallback-secret");
  assert.equal(JSON.parse(await readFile(join(root, "profile-fallback.json"), "utf8")).encrypted, false);
  await store.delete("profile-fallback");
  assert.equal(await store.get("profile-fallback"), undefined);
  await assert.rejects(() => store.set("../escape", "secret"), /Invalid provider profile id/);
});
