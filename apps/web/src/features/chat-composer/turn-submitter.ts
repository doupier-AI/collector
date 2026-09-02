import { DEFAULT_COMPOSER_PREFERENCES, type ComposerPreferences, type ResearchTurnAccepted } from "@collector/capture-contracts";

export type SubmitTurnFn = (content: string, idempotencyKey: string, options: ComposerPreferences) => Promise<ResearchTurnAccepted>;

export interface TurnSubmitterOptions {
  submit: SubmitTurnFn;
  /** 可注入的幂等键生成器，默认 crypto.randomUUID。 */
  generateKey?: () => string;
}

function defaultGenerateKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * 单次提交的幂等键管理：
 * - 提交进行中重复调用共享同一个请求，双击不会产生两个任务；
 * - 请求失败（网络结果不确定）时保留原幂等键，重试必须复用；
 * - 后端确认成功后才作废该键，用户下一次明确发送会生成新键。
 */
export class TurnSubmitter {
  private key: string | undefined;
  private composerPreferences: ComposerPreferences | undefined;
  private pending: Promise<ResearchTurnAccepted> | undefined;
  private readonly submit: SubmitTurnFn;
  private readonly generateKey: () => string;

  constructor(options: TurnSubmitterOptions) {
    this.submit = options.submit;
    this.generateKey = options.generateKey ?? defaultGenerateKey;
  }

  get submitting(): boolean {
    return this.pending !== undefined;
  }

  send(content: string, options?: { idempotencyKey?: string } & Partial<ComposerPreferences>): Promise<ResearchTurnAccepted> {
    if (this.pending) return this.pending;
    const isNewRequest = this.key === undefined;
    const key = options?.idempotencyKey ?? this.key ?? this.generateKey();
    this.key = key;
    if (isNewRequest) this.composerPreferences = {
      allowWebSearch: options?.allowWebSearch ?? DEFAULT_COMPOSER_PREFERENCES.allowWebSearch,
      thinkingEnabled: options?.thinkingEnabled ?? DEFAULT_COMPOSER_PREFERENCES.thinkingEnabled,
    };
    const request = this.submit(content, key, this.composerPreferences ?? { ...DEFAULT_COMPOSER_PREFERENCES });
    this.pending = request;
    const settle = (clearKey: boolean) => {
      if (this.pending === request) {
        this.pending = undefined;
        if (clearKey) {
          this.key = undefined;
          this.composerPreferences = undefined;
        }
      }
    };
    request.then(
      () => settle(true),
      () => settle(false),
    );
    return request;
  }
}
