import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { getChannelWorkspaceRoot, type Settings } from "@vykor/core";
import type { FeishuChannelConfig } from "@vykor/auth";
import type {
  ChannelConnectorRuntimeStatus,
  ChannelDeliveryRecord,
  ChannelDenialNotice,
  ChannelRuntimeState,
  ChannelRuntimeStatus,
  DurableChannelMessageInput,
  DurableChannelMessageResult,
  RecordChannelDeliveryInput,
} from "@vykor/protocol";
import type { InboundMessage } from "@vykor/channels";

import type { ObservabilityEvent } from "../shared/observability.js";

/** daemon 侧需要的最小 application 端口（由 ChannelApplicationService 适配）。 */
export interface ChannelRuntimeApplicationPort {
  handleMessage(input: DurableChannelMessageInput): Promise<DurableChannelMessageResult>;
  pendingDeliveries(options?: {
    connector?: string;
    limit?: number;
  }): Promise<ChannelDeliveryRecord[]>;
  recordDelivery(
    id: string,
    input: RecordChannelDeliveryInput,
  ): Promise<ChannelDeliveryRecord>;
}

/** 平台附件下载结果：字节流 + 可选文件名/类型。 */
export interface ChannelAttachmentDownload {
  stream: ReadableStream<Uint8Array>;
  name?: string;
  mimeType?: string;
}

export interface ChannelAttachmentDownloadInput {
  messageId: string;
  type: "image" | "file";
  externalId: string;
  name?: string;
  signal?: AbortSignal;
}

/** 一个 connector 的运行时句柄；由 createRuntime 返回。 */
export interface ConnectorRuntimeHandle {
  start(): Promise<void>;
  stopInbound(): Promise<void>;
  stopBridge(options?: { drainTimeoutMs?: number }): Promise<void>;
  stop(): Promise<void>;
  /** 可选：下载该 connector 入站消息的资源；未提供表示不支持。 */
  downloadAttachment?(input: ChannelAttachmentDownloadInput): Promise<ChannelAttachmentDownload | undefined>;
}

export interface CreateConnectorRuntimeInput {
  connector: string;
  config: FeishuChannelConfig;
  application: ChannelRuntimeApplicationPort;
  model: string;
  /** manager 持有同一引用；运行时原地修改即可让 ACL 立即生效。 */
  acl: { allowFrom: string[] };
  policy: { sendProgress?: boolean; sendToolHints?: boolean };
  resolveCwd(message: InboundMessage): Promise<string>;
  onDenied(info: { channel: string; sender: string; chatId: string }): void;
  onDeliveryResult(result: {
    deliveryId: string;
    status: "sent" | "failed" | "unknown";
    error?: string;
  }): Promise<void> | void;
}

export interface ChannelRuntimeServiceOptions {
  application: ChannelRuntimeApplicationPort;
  config: { getFeishu(): Promise<FeishuChannelConfig | undefined> };
  getSettings(): Settings | undefined;
  createRuntime?(input: CreateConnectorRuntimeInput): Promise<ConnectorRuntimeHandle>;
  verify?(input: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
  }): Promise<{ name?: string }>;
  workspaceRoot?: string;
  drainTimeoutMs?: number;
  /** 单个 connector 建立连接的硬上限；超时落 state=error，避免卡住 lane。 */
  connectTimeoutMs?: number;
  /** shutdown 等待 lane 的硬上限；超时后不再等，避免 daemon 关不掉。 */
  shutdownTimeoutMs?: number;
  logger?(event: ObservabilityEvent): void;
  now?(): number;
}

export type ChannelRuntimeErrorCode =
  | "unknown_connector"
  | "not_configured"
  | "not_enabled"
  | "closed";

export class ChannelRuntimeError extends Error {
  constructor(readonly code: ChannelRuntimeErrorCode, message: string) {
    super(message);
    this.name = "ChannelRuntimeError";
  }
}

interface ConnectorEntry {
  config: FeishuChannelConfig | undefined;
  fingerprint: string;
  acl: { allowFrom: string[] };
  policy: { sendProgress?: boolean; sendToolHints?: boolean };
  status: ChannelConnectorRuntimeStatus;
  lane: Promise<void>;
  handle: ConnectorRuntimeHandle | null;
}

const CONNECTOR = "feishu";
const MAX_DENIALS = 50;

/**
 * daemon 内唯一的渠道长连接所有者。
 *
 * 并发模型：每个 connector 一条 promise-chain lane，start/stop/restart/shutdown
 * 串行执行；`generation` 在每次互斥操作开始时递增，用于丢弃过期结果。
 */
export class ChannelRuntimeService {
  private readonly entries = new Map<string, ConnectorEntry>();
  private readonly denials: ChannelDenialNotice[] = [];
  private readonly botNames = new Map<string, string>();
  private readonly bootId = randomUUID();
  private readonly workspaceRoot: string;
  private readonly drainTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly now: () => number;
  private denialSeq = 0;
  private closed = false;
  /** 当前运行中 connector 的附件下载实现；随连接建立/停止变更。 */
  private attachmentDownloader:
    | ((input: ChannelAttachmentDownloadInput) => Promise<ChannelAttachmentDownload | undefined>)
    | null = null;

  constructor(private readonly options: ChannelRuntimeServiceOptions) {
    this.workspaceRoot = options.workspaceRoot ?? getChannelWorkspaceRoot();
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 15000;
    this.now = options.now ?? Date.now;
    this.ensureEntry(CONNECTOR, undefined);
  }

  hasConnector(name: string): boolean {
    return this.entries.has(name);
  }

  /**
   * 下载入站附件。仅当 connector 的连接已建立且提供了下载实现时可用；
   * 未连接/已停止返回 undefined（上层按失败处理）。
   */
  async downloadAttachment(
    messageId: string,
    attachment: Omit<ChannelAttachmentDownloadInput, "messageId">,
    signal?: AbortSignal,
  ): Promise<ChannelAttachmentDownload | undefined> {
    const downloader = this.attachmentDownloader;
    if (!downloader) return undefined;
    return downloader({ ...attachment, messageId, signal });
  }

  status(): ChannelRuntimeStatus {
    const connectors = [...this.entries.values()].map((entry) => {
      const config = entry.config;
      const botName = config
        ? this.botNames.get(botNameKey(config))
        : undefined;
      return botName ? { ...entry.status, botName } : { ...entry.status };
    });
    return {
      bootId: this.bootId,
      connectors,
      recentDenials: [...this.denials],
    };
  }

  /** daemon ready 后后台调用；任何错误都只落 status，绝不 reject。 */
  async startEnabled(): Promise<void> {
    if (this.closed) return;
    try {
      await this.start();
    } catch (error) {
      this.options.logger?.({
        level: "warn",
        event: "channel.runtime.start_failed",
        error: messageOf(error),
      });
    }
  }

  async start(connector?: string): Promise<void> {
    this.assertOpen();
    if (connector) {
      await this.enqueue(connector, () => this.startInternal(connector, true));
      return;
    }
    // 先同步入 lane，再等待；否则 stop/shutdown 可能插到 start 前面。
    const names = [...this.entries.keys()];
    const runs = names.map((name) => this.enqueue(name, () => this.startInternal(name, false)));
    await Promise.all(runs);
  }

  async stop(connector?: string): Promise<void> {
    this.assertOpen();
    for (const name of this.resolveNames(connector)) {
      await this.enqueue(name, () => this.stopInternal(name));
    }
  }

  async restart(connector?: string): Promise<void> {
    this.assertOpen();
    for (const name of this.resolveNames(connector)) {
      await this.enqueue(name, () => this.restartInternal(name));
    }
  }

  /**
   * 配置变化入口。连接指纹变化才动连接；否则只原地更新 ACL/策略，
   * 即使当前是临时停止也保持停止。
   */
  async applyFeishuConfig(config: FeishuChannelConfig | undefined): Promise<void> {
    if (this.closed) return;
    const entry = this.ensureEntry(CONNECTOR, config);
    const fingerprint = connectionFingerprint(config);
    const changed = fingerprint !== entry.fingerprint;
    const previous = entry.config;
    this.applyConfig(entry, config);
    entry.fingerprint = fingerprint;
    if (!changed) return;
    if (previous) this.botNames.delete(botNameKey(previous));
    const task = config?.enabled
      ? () => this.restartInternal(CONNECTOR)
      : () => this.stopInternal(CONNECTOR);
    await this.enqueue(CONNECTOR, task).catch((error) => {
      this.options.logger?.({
        level: "warn",
        event: "channel.runtime.apply_failed",
        error: messageOf(error),
      });
    });
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const name of [...this.entries.keys()]) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.shutdownTimeoutMs);
        this.enqueue(name, () => this.stopInternal(name))
          .catch(() => undefined)
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      });
    }
  }

  // ---------------------------------------------------------------------------

  private ensureEntry(
    name: string,
    config: FeishuChannelConfig | undefined,
  ): ConnectorEntry {
    const existing = this.entries.get(name);
    if (existing) return existing;
    const entry: ConnectorEntry = {
      config,
      fingerprint: connectionFingerprint(config),
      acl: { allowFrom: Object.values(config?.allowFrom ?? {}) },
      policy: {
        sendProgress: config?.sendProgress,
        sendToolHints: config?.sendToolHints,
      },
      status: {
        connector: name,
        enabled: Boolean(config?.enabled),
        state: "stopped",
        ...(config?.appId ? { accountId: config.appId } : {}),
        ...(config?.domain ? { domain: config.domain } : {}),
      },
      lane: Promise.resolve(),
      handle: null,
    };
    this.entries.set(name, entry);
    return entry;
  }

  private mustEntry(name: string): ConnectorEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new ChannelRuntimeError("unknown_connector", `未知通道: ${name}`);
    return entry;
  }

  private resolveNames(connector?: string): string[] {
    if (connector) {
      this.mustEntry(connector);
      return [connector];
    }
    return [...this.entries.keys()];
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ChannelRuntimeError("closed", "Channel runtime is closed");
    }
  }

  private enqueue(name: string, task: () => Promise<void>): Promise<void> {
    const entry = this.mustEntry(name);
    const run = entry.lane.then(task, task);
    entry.lane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readConfig(
    entry: ConnectorEntry,
  ): Promise<FeishuChannelConfig | undefined> {
    const config = await this.options.config.getFeishu();
    this.applyConfig(entry, config);
    return config;
  }

  private applyConfig(
    entry: ConnectorEntry,
    config: FeishuChannelConfig | undefined,
  ): void {
    entry.config = config;
    entry.acl.allowFrom.splice(
      0,
      entry.acl.allowFrom.length,
      ...Object.values(config?.allowFrom ?? {}),
    );
    entry.policy.sendProgress = config?.sendProgress;
    entry.policy.sendToolHints = config?.sendToolHints;
    entry.status = {
      connector: entry.status.connector,
      enabled: Boolean(config?.enabled),
      state: entry.status.state,
      ...(entry.status.startedAt !== undefined ? { startedAt: entry.status.startedAt } : {}),
      ...(entry.status.lastError !== undefined ? { lastError: entry.status.lastError } : {}),
      ...(config?.appId ? { accountId: config.appId } : {}),
      ...(config?.domain ? { domain: config.domain } : {}),
    };
  }

  private patchStatus(
    entry: ConnectorEntry,
    patch: Partial<ChannelConnectorRuntimeStatus>,
  ): void {
    const next: ChannelConnectorRuntimeStatus = { ...entry.status, ...patch };
    for (const key of Object.keys(patch) as Array<keyof ChannelConnectorRuntimeStatus>) {
      if (patch[key] === undefined) {
        delete (next as unknown as Record<string, unknown>)[key];
      }
    }
    entry.status = next;
  }

  private async startInternal(name: string, strict: boolean): Promise<void> {
    const entry = this.mustEntry(name);
    if (this.closed) {
      this.patchStatus(entry, { state: "stopped", startedAt: undefined });
      return;
    }
    let config: FeishuChannelConfig | undefined;
    try {
      config = await this.readConfig(entry);
    } catch (error) {
      this.patchStatus(entry, { state: "error", lastError: messageOf(error) });
      if (strict) throw error;
      return;
    }
    if (this.closed) {
      this.patchStatus(entry, { state: "stopped", startedAt: undefined });
      return;
    }
    if (!config) {
      this.patchStatus(entry, { state: "stopped" });
      if (strict) throw new ChannelRuntimeError("not_configured", `渠道未配置: ${name}`);
      return;
    }
    if (!config.enabled) {
      this.patchStatus(entry, { state: "stopped" });
      if (strict) throw new ChannelRuntimeError("not_enabled", `渠道未启用: ${name}`);
      return;
    }
    if (entry.handle) return;
    entry.fingerprint = connectionFingerprint(config);
    const model = this.options.getSettings()?.model;
    if (!model) {
      // 运行期问题只落 status，不抛：HTTP 返回 200 + state=error。
      this.patchStatus(entry, { state: "error", lastError: "未配置模型" });
      return;
    }
    this.patchStatus(entry, { state: "starting", lastError: undefined, startedAt: undefined });
    let handle: ConnectorRuntimeHandle;
    try {
      handle = await this.createRuntime(entry, config, model);
    } catch (error) {
      this.patchStatus(entry, { state: "error", lastError: messageOf(error) });
      return;
    }
    if (this.closed) {
      await handle.stop().catch(() => undefined);
      this.patchStatus(entry, { state: "stopped", startedAt: undefined });
      return;
    }
    let starting: Promise<void> | undefined;
    try {
      starting = handle.start();
      await withTimeout(
        starting,
        this.connectTimeoutMs,
        `连接超时（${this.connectTimeoutMs}ms）`,
      );
    } catch (error) {
      this.patchStatus(entry, { state: "error", lastError: messageOf(error) });
      await handle.stop().catch(() => undefined);
      if (starting) {
        void starting.then(
          () => handle.stop().catch(() => undefined),
          () => undefined,
        );
      }
      return;
    }
    if (this.closed) {
      await handle.stop().catch(() => undefined);
      this.patchStatus(entry, { state: "stopped", startedAt: undefined });
      return;
    }
    entry.handle = handle;
    this.attachmentDownloader = handle.downloadAttachment
      ? (input) => handle.downloadAttachment!(input)
      : null;
    this.patchStatus(entry, {
      state: "running",
      startedAt: this.now(),
      lastError: undefined,
    });
    void this.probeBotName(entry, config);
  }

  private async stopInternal(name: string): Promise<void> {
    const entry = this.mustEntry(name);
    const handle = entry.handle;
    entry.handle = null;
    this.attachmentDownloader = null;
    if (!handle) {
      this.patchStatus(entry, { state: "stopped", startedAt: undefined });
      return;
    }
    this.patchStatus(entry, { state: "stopping" });
    await handle.stopInbound().catch(() => undefined);
    await handle.stopBridge({ drainTimeoutMs: this.drainTimeoutMs }).catch(() => undefined);
    await handle.stop().catch(() => undefined);
    this.patchStatus(entry, { state: "stopped", startedAt: undefined });
  }

  private async restartInternal(name: string): Promise<void> {
    await this.stopInternal(name);
    await this.startInternal(name, true);
  }

  private createRuntime(
    entry: ConnectorEntry,
    config: FeishuChannelConfig,
    model: string,
  ): Promise<ConnectorRuntimeHandle> {
    const factory = this.options.createRuntime ?? ((input) => this.defaultCreateRuntime(input));
    return factory({
      connector: CONNECTOR,
      config,
      application: this.options.application,
      model,
      acl: entry.acl,
      policy: entry.policy,
      resolveCwd: (message) => this.resolveCwd(entry, message),
      onDenied: (info) => this.recordDenial(info),
      onDeliveryResult: (result) => this.recordDeliveryResult(result),
    });
  }

  private async defaultCreateRuntime(
    input: CreateConnectorRuntimeInput,
  ): Promise<ConnectorRuntimeHandle> {
    const channels = await import("@vykor/channels");
    const adapter = new channels.FeishuAdapter({
      appId: input.config.appId,
      appSecret: input.config.appSecret,
      domain: input.config.domain,
      ...(input.config.replyAtBotNames
        ? { replyAtBotNames: input.config.replyAtBotNames }
        : {}),
    });
    const bus = new channels.MessageBus();
    const manager = new channels.ChannelManager([adapter], bus, {
      allowFrom: { [input.connector]: input.acl.allowFrom },
      accountIds: { [input.connector]: input.config.appId },
      channelPolicies: { [input.connector]: input.policy },
      onWarning: (message) =>
        this.options.logger?.({
          level: "warn",
          event: "channel.runtime.warning",
          error: message,
        }),
      onDenied: (info) => input.onDenied(info),
      onDeliveryResult: (result) => input.onDeliveryResult(result),
    });
    const bridge = new channels.DurableChannelBridge({
      application: {
        handleChannelMessage: (message) => input.application.handleMessage(message),
        listPendingChannelDeliveries: (options) =>
          input.application.pendingDeliveries(options),
        recordChannelDelivery: (id, record) =>
          input.application.recordDelivery(id, record),
      },
      bus,
      cwd: input.resolveCwd,
      model: input.model,
      connectors: [input.connector],
      onWarning: (message) =>
        this.options.logger?.({
          level: "warn",
          event: "channel.runtime.warning",
          error: message,
        }),
    });
    return {
      start: async () => {
        await manager.startAll();
        const status = manager.getStatus()[input.connector];
        if (!status?.running) {
          throw new Error(status?.lastError ?? `通道 ${input.connector} 启动失败`);
        }
        bridge.start();
      },
      stopInbound: () => manager.stopInbound(),
      stopBridge: (options) => bridge.stop(options),
      downloadAttachment: (download) =>
        adapter.downloadAttachment({
          messageId: download.messageId,
          fileKey: download.externalId,
          type: download.type,
          signal: download.signal,
        }),
      stop: async () => {
        await bridge.stop();
        await manager.stopAll();
      },
    };
  }

  private async resolveCwd(
    entry: ConnectorEntry,
    message: InboundMessage,
  ): Promise<string> {
    const config = entry.config;
    const directory = join(
      this.workspaceRoot,
      entry.status.connector,
      workspaceDirName(
        entry.status.connector,
        config?.appId ?? message.accountId,
        message.chatId,
        message.threadId,
      ),
    );
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      this.patchStatus(entry, {
        lastError: `无法创建渠道工作目录: ${messageOf(error)}`,
      });
      throw error;
    }
    return directory;
  }

  private recordDenial(info: {
    channel: string;
    sender: string;
    chatId: string;
  }): void {
    this.denialSeq += 1;
    this.denials.push({
      connector: info.channel,
      sender: info.sender,
      chatId: info.chatId,
      at: this.now(),
      seq: this.denialSeq,
    });
    if (this.denials.length > MAX_DENIALS) {
      this.denials.splice(0, this.denials.length - MAX_DENIALS);
    }
    this.options.logger?.({
      level: "warn",
      event: "channel.runtime.denied",
      error: `${info.channel} denied ${info.sender} in ${info.chatId}`,
    });
  }

  private async recordDeliveryResult(result: {
    deliveryId: string;
    status: "sent" | "failed" | "unknown";
    error?: string;
  }): Promise<void> {
    try {
      await this.options.application.recordDelivery(result.deliveryId, {
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
    } catch (error) {
      this.options.logger?.({
        level: "warn",
        event: "channel.runtime.delivery_record_failed",
        error: messageOf(error),
      });
      throw error;
    }
  }

  private async probeBotName(
    entry: ConnectorEntry,
    config: FeishuChannelConfig,
  ): Promise<void> {
    const key = botNameKey(config);
    if (this.botNames.has(key)) return;
    const verify =
      this.options.verify ??
      (async (input: { appId: string; appSecret: string; domain: "feishu" | "lark" }) => {
        const channels = await import("@vykor/channels");
        return channels.verifyFeishuCredentials(input);
      });
    try {
      const verified = await verify({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: config.domain,
      });
      if (verified.name) this.botNames.set(key, verified.name);
    } catch (error) {
      // botName 仅用于展示，取不到不影响运行，但把原因记下来。
      this.patchStatus(entry, { lastError: `机器人信息获取失败: ${messageOf(error)}` });
    }
  }
}

function botNameKey(config: FeishuChannelConfig): string {
  return `${config.appId}|${config.domain}`;
}

function connectionFingerprint(config: FeishuChannelConfig | undefined): string {
  if (!config) return "none";
  return JSON.stringify({
    enabled: config.enabled,
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    replyAtBotNames: config.replyAtBotNames ?? [],
  });
}

export function workspaceDirName(
  connector: string,
  accountId: string,
  chatId: string,
  threadId?: string,
): string {
  const hash = createHash("sha1")
    .update([connector, accountId, chatId, threadId ?? ""].join("|"))
    .digest("hex")
    .slice(0, 12);
  return `${sanitizeSegment(chatId)}-${hash}`;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const normalized = process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    /[. ]$/.test(normalized)
  ) {
    return normalized ? `session_${normalized}` : "session";
  }
  return normalized;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 给一个 promise 加硬超时；超时后原 promise 仍在后台，但不再阻塞调用方。 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
