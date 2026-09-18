type FeishuDomain = "feishu" | "lark";

export type FeishuRegistrationState =
  | "idle"
  | "starting"
  | "qr_ready"
  | "polling"
  | "slow_down"
  | "domain_switched"
  | "succeeded"
  | "expired"
  | "cancelled"
  | "error";

export interface FeishuRegistrationStatus {
  state: FeishuRegistrationState;
  attempt: number;
  domain: FeishuDomain;
  qrUrl?: string;
  expiresAt?: number;
  remainingSeconds?: number;
  pollIntervalMs?: number;
  error?: { code: string; message: string };
}

export interface FeishuRegistrationCredentials {
  appId: string;
  appSecret: string;
  userId?: string;
  domain: FeishuDomain;
}

export interface FeishuRegistrationStartOptions {
  appName?: string;
  appDesc?: string;
  domain?: FeishuDomain;
  source?: string;
}

interface RegisterAppResult {
  client_id: string;
  client_secret: string;
  user_info?: { open_id?: string; tenant_brand?: FeishuDomain };
}

type RegisterAppFn = (options: Record<string, unknown>) => Promise<RegisterAppResult>;

interface RegistrationRun {
  id: number;
  controller: AbortController;
  qrUrl: string | null;
  expiresAt: number | null;
  pollIntervalMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const ACTIVE = new Set<FeishuRegistrationState>([
  "starting",
  "qr_ready",
  "polling",
  "slow_down",
  "domain_switched",
]);

const POLLING_STATES = new Set(["polling", "slow_down", "domain_switched"] as const);

/** 新建应用时预填的租户权限。 */
export const FEISHU_ONBOARDING_TENANT_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:send_as_bot",
  "im:resource",
] as const;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "access_denied" || code === "expired_token" || code === "abort") {
    return code;
  }
  return "registration_failed";
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "扫码授权被拒绝。",
  abort: "已取消扫码。",
  expired_token: "二维码已过期。",
};

export class FeishuRegistration {
  #registerApp: RegisterAppFn;
  #onCredentials: (credentials: FeishuRegistrationCredentials) => Promise<void>;
  #now: () => number;
  #setTimeout: typeof setTimeout;
  #clearTimeout: typeof clearTimeout;
  #attempt = 0;
  #active: RegistrationRun | null = null;
  #snapshot: FeishuRegistrationStatus;

  constructor(deps: {
    registerApp?: RegisterAppFn;
    onCredentials: (credentials: FeishuRegistrationCredentials) => Promise<void>;
    now?: () => number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  }) {
    this.#onCredentials = deps.onCredentials;
    this.#now = deps.now ?? Date.now;
    this.#setTimeout = deps.setTimeout ?? setTimeout;
    this.#clearTimeout = deps.clearTimeout ?? clearTimeout;
    this.#registerApp =
      deps.registerApp ??
      ((options) =>
        import("@larksuiteoapi/node-sdk").then(
          (lark) => lark.registerApp(options as never) as Promise<RegisterAppResult>,
        ));
    this.#snapshot = { state: "idle", attempt: 0, domain: "feishu" };
  }

  start(options: FeishuRegistrationStartOptions = {}): FeishuRegistrationStatus {
    this.#supersede();
    const domain = options.domain ?? "feishu";
    const run: RegistrationRun = {
      id: ++this.#attempt,
      controller: new AbortController(),
      qrUrl: null,
      expiresAt: null,
      pollIntervalMs: null,
      timer: null,
    };
    this.#active = run;
    this.#snapshot = { state: "starting", attempt: run.id, domain };

    const registerOptions: Record<string, unknown> = {
      source: options.source ?? "openharness",
      domain: domain === "lark" ? "accounts.larksuite.com" : "accounts.feishu.cn",
      createOnly: true,
      appPreset: {
        name: options.appName ?? "{user} 的 OpenHarness 机器人",
        desc: options.appDesc ?? "把飞书接入 OpenHarness。",
      },
      addons: {
        preset: true,
        scopes: { tenant: [...FEISHU_ONBOARDING_TENANT_SCOPES] },
        events: { items: { tenant: ["im.message.receive_v1"] } },
        callbacks: { items: ["card.action.trigger"] },
      },
      signal: run.controller.signal,
      onQRCodeReady: (info: { url: string; expireIn: number }) => this.#onQrReady(run, info),
      onStatusChange: (info: { status: string; interval?: number }) =>
        queueMicrotask(() => this.#onStatusChange(run, info)),
    };

    let pending: Promise<RegisterAppResult>;
    try {
      pending = this.#registerApp(registerOptions);
    } catch (error) {
      this.#onFailed(run, error);
      return this.status();
    }

    pending.then(
      (result) => this.#onSucceeded(run, result),
      (error) => this.#onFailed(run, error),
    );

    return this.status();
  }

  status(): FeishuRegistrationStatus {
    this.#expireIfNeeded();
    const snapshot = { ...this.#snapshot };
    if (snapshot.error) snapshot.error = { ...snapshot.error };
    const run = this.#active;
    if (run && run.expiresAt !== null && ACTIVE.has(snapshot.state)) {
      snapshot.remainingSeconds = Math.max(0, Math.ceil((run.expiresAt - this.#now()) / 1000));
    }
    return snapshot;
  }

  cancel(): FeishuRegistrationStatus {
    const run = this.#active;
    if (!run) return this.status();
    this.#finish(run, "cancelled", { code: "abort", message: ERROR_MESSAGES.abort! });
    run.controller.abort();
    return this.status();
  }

  #isCurrent(run: RegistrationRun): boolean {
    return this.#active === run;
  }

  #onQrReady(run: RegistrationRun, info: { url: string; expireIn: number }): void {
    if (!this.#isCurrent(run)) return;
    if (typeof info?.url !== "string" || !info.url) return;
    const seconds = Number(info.expireIn);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    run.qrUrl = info.url;
    run.expiresAt = this.#now() + seconds * 1000;
    if (run.timer) this.#clearTimeout(run.timer);
    run.timer = this.#setTimeout(() => this.#expire(run), seconds * 1000);
    (run.timer as { unref?: () => void }).unref?.();
    this.#snapshot = {
      state: "qr_ready",
      attempt: run.id,
      domain: this.#snapshot.domain,
      qrUrl: run.qrUrl,
      expiresAt: run.expiresAt,
    };
  }

  #onStatusChange(run: RegistrationRun, info: { status: string; interval?: number }): void {
    if (!this.#isCurrent(run) || !POLLING_STATES.has(info?.status as never)) return;
    if (info.status === "slow_down" && Number.isFinite(Number(info.interval))) {
      run.pollIntervalMs = Number(info.interval) * 1000;
    }
    this.#snapshot = {
      state: info.status as FeishuRegistrationState,
      attempt: run.id,
      domain: this.#snapshot.domain,
      ...(run.qrUrl ? { qrUrl: run.qrUrl } : {}),
      ...(run.expiresAt !== null ? { expiresAt: run.expiresAt } : {}),
      ...(run.pollIntervalMs !== null ? { pollIntervalMs: run.pollIntervalMs } : {}),
    };
  }

  async #onSucceeded(run: RegistrationRun, result: RegisterAppResult): Promise<void> {
    if (!this.#isCurrent(run)) return;
    const appId = result?.client_id;
    const appSecret = result?.client_secret;
    if (typeof appId !== "string" || !appId || typeof appSecret !== "string" || !appSecret) {
      this.#finish(run, "error", { code: "invalid_credentials", message: "扫码返回的凭据不完整。" });
      return;
    }
    const domain = result.user_info?.tenant_brand ?? this.#snapshot.domain;
    this.#clearTimer(run);
    run.qrUrl = null;
    run.expiresAt = null;
    try {
      await this.#onCredentials({
        appId,
        appSecret,
        ...(result.user_info?.open_id ? { userId: result.user_info.open_id } : {}),
        domain,
      });
    } catch {
      if (this.#isCurrent(run)) {
        this.#finish(run, "error", { code: "credentials_callback_failed", message: "保存凭据失败。" });
      }
      return;
    }
    if (this.#isCurrent(run)) this.#finish(run, "succeeded");
  }

  #onFailed(run: RegistrationRun, error: unknown): void {
    if (!this.#isCurrent(run)) return;
    const code = errorCode(error);
    const state: FeishuRegistrationState =
      code === "expired_token" ? "expired" : code === "abort" ? "cancelled" : "error";
    this.#finish(run, state, {
      code,
      message: ERROR_MESSAGES[code] ?? "飞书应用创建失败。",
    });
  }

  #expireIfNeeded(): void {
    const run = this.#active;
    if (run && run.expiresAt !== null && this.#now() >= run.expiresAt) this.#expire(run);
  }

  #expire(run: RegistrationRun): void {
    if (!this.#isCurrent(run)) return;
    this.#finish(run, "expired", { code: "expired_token", message: ERROR_MESSAGES.expired_token! });
    run.controller.abort();
  }

  #finish(
    run: RegistrationRun,
    state: FeishuRegistrationState,
    error?: { code: string; message: string },
  ): void {
    if (!this.#isCurrent(run)) return;
    this.#clearTimer(run);
    this.#snapshot = {
      state,
      attempt: run.id,
      domain: this.#snapshot.domain,
      ...(error ? { error } : {}),
    };
    this.#active = null;
  }

  #clearTimer(run: RegistrationRun): void {
    if (run.timer) {
      this.#clearTimeout(run.timer);
      run.timer = null;
    }
  }

  #supersede(): void {
    const previous = this.#active;
    if (!previous) return;
    this.#clearTimer(previous);
    this.#active = null;
    previous.controller.abort();
  }
}
