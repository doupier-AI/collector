import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface CredentialEnvelope {
  version: 1;
  encrypted: boolean;
  payload: string;
}

export class FileCredentialStore {
  constructor(private readonly root: string, private readonly encryption: CredentialEncryption) {}

  async get(profileId: string): Promise<string | undefined> {
    const path = this.pathFor(profileId);
    let envelope: CredentialEnvelope;
    try {
      envelope = parseEnvelope(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      console.error("Failed to read provider credential", safeError(error));
      return undefined;
    }

    if (envelope.encrypted) {
      if (!this.encryptionAvailable()) return undefined;
      try { return this.encryption.decryptString(Buffer.from(envelope.payload, "base64")); }
      catch (error) {
        console.error("Failed to decrypt provider credential", safeError(error));
        return undefined;
      }
    }

    const plaintext = Buffer.from(envelope.payload, "base64").toString("utf8");
    if (this.encryptionAvailable()) {
      try { await this.writeEnvelope(path, { version: 1, encrypted: true, payload: this.encryption.encryptString(plaintext).toString("base64") }); }
      catch (error) { console.warn("Provider credential could not be upgraded to encrypted storage", safeError(error)); }
    }
    return plaintext;
  }

  async set(profileId: string, value: string): Promise<void> {
    if (!value) throw new Error("Credential cannot be empty");
    const path = this.pathFor(profileId);
    let envelope: CredentialEnvelope;
    if (this.encryptionAvailable()) {
      try { envelope = { version: 1, encrypted: true, payload: this.encryption.encryptString(value).toString("base64") }; }
      catch (error) {
        console.warn("Provider credential encryption failed; using explicit plaintext fallback", safeError(error));
        envelope = plaintextEnvelope(value);
      }
    } else {
      envelope = plaintextEnvelope(value);
    }
    await this.writeEnvelope(path, envelope);
  }

  async delete(profileId: string): Promise<void> {
    await rm(this.pathFor(profileId), { force: true });
  }

  private encryptionAvailable(): boolean {
    try { return this.encryption.isEncryptionAvailable(); }
    catch (error) {
      console.warn("Credential encryption availability check failed", safeError(error));
      return false;
    }
  }

  private async writeEnvelope(path: string, envelope: CredentialEnvelope): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), "utf8");
    await rename(temporary, path);
  }

  private pathFor(profileId: string): string {
    if (!profileId.match(/^[a-zA-Z0-9_-]{1,128}$/)) throw new Error("Invalid provider profile id");
    return join(this.root, `${profileId}.json`);
  }
}

function plaintextEnvelope(value: string): CredentialEnvelope {
  return { version: 1, encrypted: false, payload: Buffer.from(value, "utf8").toString("base64") };
}

function parseEnvelope(value: string): CredentialEnvelope {
  const parsed = JSON.parse(value) as Partial<CredentialEnvelope>;
  if (parsed.version !== 1 || typeof parsed.encrypted !== "boolean" || typeof parsed.payload !== "string") throw new Error("Unsupported provider credential envelope");
  return parsed as CredentialEnvelope;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{20,}/g, "[REDACTED]") : "credential storage error";
}
