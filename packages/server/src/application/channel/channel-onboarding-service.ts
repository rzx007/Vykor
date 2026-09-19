import type { ChannelConfigStore, FeishuChannelConfig } from "@openharness/auth";
import type {
  FeishuRegistrationCredentials,
  FeishuRegistrationStatus,
} from "@openharness/channels";
import type {
  FeishuChannelSnapshot,
  FeishuRegistrationSnapshot,
} from "@openharness/protocol";

import type { ObservabilityEvent } from "../../shared/observability.js";

export interface RegistrationLike {
  start(options?: { domain?: "feishu" | "lark" }): FeishuRegistrationStatus;
  status(): FeishuRegistrationStatus;
  cancel(): FeishuRegistrationStatus;
}

export interface ChannelOnboardingServiceOptions {
  config: ChannelConfigStore;
  onConfigChanged(connector: string): Promise<void> | void;
  createRegistration?(
    onCredentials: (credentials: FeishuRegistrationCredentials) => Promise<void>,
  ): RegistrationLike | Promise<RegistrationLike>;
  verify?(input: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
  }): Promise<{ name?: string }>;
  readBotName?(): string | undefined;
  logger?(event: ObservabilityEvent): void;
}

export type ChannelOnboardingErrorCode =
  | "not_configured"
  | "verify_failed"
  | "invalid_input";

export class ChannelOnboardingError extends Error {
  constructor(readonly code: ChannelOnboardingErrorCode, message: string) {
    super(message);
    this.name = "ChannelOnboardingError";
  }
}

const CONNECTOR = "feishu";
const MISSING_OPEN_ID_WARNING =
  "未获取到扫码者 open_id，白名单为空，所有消息都会被拒绝";

/** daemon 侧唯一写 channel-credentials.json 的入口：接入、校验、白名单、启停。 */
export class ChannelOnboardingService {
  private registration: RegistrationLike | undefined;
  private registrationWarning: string | undefined;
  private lastAttempt = 0;
  private lastDomain: "feishu" | "lark" = "feishu";

  constructor(private readonly options: ChannelOnboardingServiceOptions) {}

  async snapshot(): Promise<FeishuChannelSnapshot> {
    return this.toSnapshot(await this.options.config.getFeishu());
  }

  async connectManual(input: {
    appId: string;
    appSecret: string;
    domain?: "feishu" | "lark";
  }): Promise<FeishuChannelSnapshot> {
    const domain = input.domain ?? "feishu";
    try {
      await this.verify({ appId: input.appId, appSecret: input.appSecret, domain });
    } catch (error) {
      throw new ChannelOnboardingError("verify_failed", messageOf(error));
    }
    const existing = await this.options.config.getFeishu();
    const sameApp = existing?.appId === input.appId;
    const next: FeishuChannelConfig = {
      enabled: true,
      appId: input.appId,
      appSecret: input.appSecret,
      domain,
      allowFrom: sameApp ? { ...existing?.allowFrom } : {},
      ...(existing?.replyAtBotNames ? { replyAtBotNames: existing.replyAtBotNames } : {}),
      ...(existing?.sendProgress !== undefined ? { sendProgress: existing.sendProgress } : {}),
      ...(existing?.sendToolHints !== undefined
        ? { sendToolHints: existing.sendToolHints }
        : {}),
    };
    await this.options.config.setFeishu(next);
    await this.notifyConfigChanged();
    return this.toSnapshot(next);
  }

  async patch(input: {
    enabled?: boolean;
    sendProgress?: boolean;
    sendToolHints?: boolean;
  }): Promise<FeishuChannelSnapshot> {
    const existing = await this.options.config.getFeishu();
    if (!existing) throw new ChannelOnboardingError("not_configured", "渠道未配置");
    const next: FeishuChannelConfig = {
      ...existing,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.sendProgress !== undefined ? { sendProgress: input.sendProgress } : {}),
      ...(input.sendToolHints !== undefined ? { sendToolHints: input.sendToolHints } : {}),
    };
    await this.options.config.setFeishu(next);
    await this.notifyConfigChanged();
    return this.toSnapshot(next);
  }

  async remove(): Promise<FeishuChannelSnapshot> {
    await this.options.config.deleteFeishu();
    await this.notifyConfigChanged();
    return this.toSnapshot(undefined);
  }

  async allowAdd(input: { id: string; name?: string }): Promise<FeishuChannelSnapshot> {
    const existing = await this.options.config.getFeishu();
    if (!existing) throw new ChannelOnboardingError("not_configured", "渠道未配置");
    const key = input.name?.trim() || input.id;
    const next: FeishuChannelConfig = {
      ...existing,
      allowFrom: { ...existing.allowFrom, [key]: input.id },
    };
    await this.options.config.setFeishu(next);
    await this.notifyConfigChanged();
    return this.toSnapshot(next);
  }

  async allowRemove(key: string): Promise<FeishuChannelSnapshot> {
    const existing = await this.options.config.getFeishu();
    if (!existing) throw new ChannelOnboardingError("not_configured", "渠道未配置");
    const allowFrom = { ...existing.allowFrom };
    delete allowFrom[key];
    const next: FeishuChannelConfig = { ...existing, allowFrom };
    await this.options.config.setFeishu(next);
    await this.notifyConfigChanged();
    return this.toSnapshot(next);
  }

  async startRegistration(input: { domain?: "feishu" | "lark" } = {}): Promise<FeishuRegistrationSnapshot> {
    if (!this.registration) {
      const create =
        this.options.createRegistration ??
        (async (onCredentials) => {
          const { FeishuRegistration } = await import("@openharness/channels");
          return new FeishuRegistration({ onCredentials });
        });
      this.registration = await create((credentials) => this.onCredentials(credentials));
    }
    this.registrationWarning = undefined;
    this.registration.start({ domain: input.domain ?? "feishu" });
    return this.registrationSnapshot();
  }

  registrationStatus(): FeishuRegistrationSnapshot {
    return this.registrationSnapshot();
  }

  cancelRegistration(): FeishuRegistrationSnapshot {
    this.registration?.cancel();
    return this.registrationSnapshot();
  }

  // ---------------------------------------------------------------------------

  private async onCredentials(
    credentials: FeishuRegistrationCredentials,
  ): Promise<void> {
    const existing = await this.options.config.getFeishu();
    const allowFrom: Record<string, string> = {};
    if (credentials.userId) allowFrom[credentials.userId] = credentials.userId;
    this.registrationWarning = credentials.userId ? undefined : MISSING_OPEN_ID_WARNING;
    // 扫码走 createOnly，appId 必然变化：清空旧应用白名单，只保留扫码者本人。
    const next: FeishuChannelConfig = {
      enabled: true,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: credentials.domain,
      allowFrom,
      ...(existing?.replyAtBotNames ? { replyAtBotNames: existing.replyAtBotNames } : {}),
      ...(existing?.sendProgress !== undefined ? { sendProgress: existing.sendProgress } : {}),
      ...(existing?.sendToolHints !== undefined
        ? { sendToolHints: existing.sendToolHints }
        : {}),
    };
    await this.options.config.setFeishu(next);
    await this.notifyConfigChanged();
  }

  private async notifyConfigChanged(): Promise<void> {
    try {
      await this.options.onConfigChanged(CONNECTOR);
    } catch (error) {
      this.options.logger?.({
        level: "warn",
        event: "channel.onboarding.config_changed_failed",
        error: messageOf(error),
      });
    }
  }

  private async verify(input: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
  }): Promise<{ name?: string }> {
    if (this.options.verify) return this.options.verify(input);
    const { verifyFeishuCredentials } = await import("@openharness/channels");
    return verifyFeishuCredentials(input);
  }

  private registrationSnapshot(): FeishuRegistrationSnapshot {
    if (!this.registration) {
      return { state: "idle", attempt: this.lastAttempt, domain: this.lastDomain };
    }
    const status = this.registration.status();
    this.lastAttempt = status.attempt;
    this.lastDomain = status.domain;
    return {
      state: status.state,
      attempt: status.attempt,
      domain: status.domain,
      ...(status.qrUrl ? { qrUrl: status.qrUrl } : {}),
      ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
      ...(status.remainingSeconds !== undefined
        ? { remainingSeconds: status.remainingSeconds }
        : {}),
      ...(status.pollIntervalMs !== undefined
        ? { pollIntervalMs: status.pollIntervalMs }
        : {}),
      ...(status.error ? { error: status.error } : {}),
      ...(this.registrationWarning ? { warning: this.registrationWarning } : {}),
    };
  }

  private toSnapshot(config: FeishuChannelConfig | undefined): FeishuChannelSnapshot {
    const botName = this.options.readBotName?.();
    if (!config) {
      return { configured: false, enabled: false, allowFrom: [] };
    }
    return {
      configured: true,
      enabled: config.enabled,
      appId: config.appId,
      domain: config.domain,
      ...(botName ? { botName } : {}),
      allowFrom: Object.entries(config.allowFrom).map(([name, id]) => ({ name, id })),
      ...(config.replyAtBotNames ? { replyAtBotNames: config.replyAtBotNames } : {}),
      ...(config.sendProgress !== undefined ? { sendProgress: config.sendProgress } : {}),
      ...(config.sendToolHints !== undefined ? { sendToolHints: config.sendToolHints } : {}),
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
