import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { CollectorStore } from "./store.js";

// 配对码有效期：生产固定 5 分钟；E2E 经 COLLECTOR_E2E_PAIRING_TTL_MS 覆盖——
// 长套件中测试排队消费现铸码，若取码与用码间隔超过 5 分钟 TTL，配对失败会
// 触发 10 次/分钟限流级联（#61 四级验证实测 80 失败中约 35 个源自此）。e2e
// 环境只绑定回环，无安全含义，TTL 放宽到 1 小时即可消除级联。
const PAIRING_TTL_MS = Number(process.env.COLLECTOR_E2E_PAIRING_TTL_MS ?? 5 * 60 * 1000);
const PAIRING_FAILURE_WINDOW_MS = 60 * 1000;
const MAX_PAIRING_FAILURES_PER_WINDOW = 10;

interface PairingCode {
  expiresAt: number;
  name: string;
}

export class LocalAuth {
  private readonly pairings = new Map<string, PairingCode>();
  private pairingFailures: number[] = [];

  constructor(private readonly store: CollectorStore) {}

  async registerTrustedToken(token: string, name = "Collector Desktop"): Promise<void> {
    await this.store.saveClientToken(randomUUID(), name, hashToken(token), new Date().toISOString());
  }

  createPairingCode(name = "Collector Client"): { code: string; expiresAt: string } {
    this.purgeExpired();
    let code: string;
    do { code = String(randomInt(0, 1_000_000)).padStart(6, "0"); } while (this.pairings.has(hashToken(code)));
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairings.set(hashToken(code), { expiresAt, name });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async exchangePairingCode(value: string): Promise<string | undefined> {
    this.purgeExpired();
    this.enforcePairingRateLimit();
    const codeHash = hashToken(value.trim());
    const pairing = this.pairings.get(codeHash);
    if (!pairing || pairing.expiresAt < Date.now()) {
      this.pairingFailures.push(Date.now());
      return undefined;
    }
    this.pairings.delete(codeHash);
    const token = randomBytes(32).toString("base64url");
    await this.store.saveClientToken(randomUUID(), pairing.name, hashToken(token), new Date().toISOString());
    return token;
  }

  isAuthorized(token: string | undefined): boolean {
    return Boolean(token && this.store.hasClientToken(hashToken(token)));
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, pairing] of this.pairings) if (pairing.expiresAt < now) this.pairings.delete(id);
  }

  private enforcePairingRateLimit(): void {
    const cutoff = Date.now() - PAIRING_FAILURE_WINDOW_MS;
    this.pairingFailures = this.pairingFailures.filter((timestamp) => timestamp >= cutoff);
    if (this.pairingFailures.length >= MAX_PAIRING_FAILURES_PER_WINDOW) throw new PairingRateLimitError();
  }
}

export class PairingRateLimitError extends Error {
  constructor() { super("Too many pairing attempts; wait one minute and try again"); }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
