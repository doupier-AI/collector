import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function deriveKey(instanceId: string): Buffer {
  return createHash("sha256").update(`collector:credential:v1:${instanceId}`).digest();
}

/**
 * 使用 AES-256-GCM 加密凭证。
 * 返回 base64 编码的 IV + ciphertext + auth tag。
 */
export function encryptCredential(plaintext: string, instanceId: string): string {
  const key = deriveKey(instanceId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
}

/**
 * 解密 AES-256-GCM 加密的凭证。
 * 解密失败或格式不正确时返回 undefined。
 */
export function decryptCredential(encrypted: string, instanceId: string): string | undefined {
  try {
    const key = deriveKey(instanceId);
    const data = Buffer.from(encrypted, "base64");
    if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) return undefined;
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}
