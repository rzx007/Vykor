import { Command } from "commander";

import type { ChannelRuntimeStatus } from "@openharness/client";
import { runChannelsAddFeishu, runChannelsAllow } from "./channels-onboarding.js";

/**
 * `ohs channels` 子命令（D.2）。渠道长连接与配置都归 daemon 所有，
 * CLI 只是客户端：serve/status 读 daemon，add/allow 委托 daemon 写配置。
 */

/** serve 跟随所需的最小客户端面（便于测试注入）。 */
export interface ChannelsRuntimeClientLike {
  channels: {
    startRuntime(input?: { connector?: string }): Promise<ChannelRuntimeStatus>;
    stopRuntime(input?: { connector?: string }): Promise<ChannelRuntimeStatus>;
    runtimeStatus(): Promise<ChannelRuntimeStatus>;
  };
}

export interface RuntimeFollowerOptions {
  client: ChannelsRuntimeClientLike;
  signal: AbortSignal;
  intervalMs?: number;
  log(message: string): void;
  warn(message: string): void;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function connectorLabel(status: ChannelRuntimeStatus): string {
  return status.connectors
    .map((connector) => {
      const suffix = connector.lastError ? ` (${connector.lastError})` : "";
      return `${connector.connector}: ${connector.state}${suffix}`;
    })
    .join(", ");
}

/** 启动 daemon 渠道运行时并跟随状态/拒绝，直到 signal 中止后停止。 */
export async function followChannelRuntime(
  options: RuntimeFollowerOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? 1000;
  const { client, signal } = options;
  try {
    await client.channels.startRuntime();
    options.log("[channels] 渠道由 daemon 托管，Ctrl+C 退出。");
  } catch (error) {
    options.warn(`[channels] 启动渠道失败：${messageOf(error)}`);
    return;
  }

  let bootId: string | undefined;
  let highWater = -1;
  const lastStates = new Map<string, string>();
  let backoff = intervalMs;

  try {
    while (!signal.aborted) {
      let status: ChannelRuntimeStatus;
      try {
        status = await client.channels.runtimeStatus();
        backoff = intervalMs;
      } catch (error) {
        options.warn(`[channels] 读取渠道状态失败：${messageOf(error)}`);
        await delay(Math.min(backoff * 2, 30_000), signal);
        continue;
      }
      if (status.bootId !== bootId) {
        // 首次成功轮询 / daemon 重启：只建基线，不重放历史拒绝。
        bootId = status.bootId;
        highWater = maxDenialSeq(status);
        lastStates.clear();
      }
      for (const connector of status.connectors) {
        if (lastStates.get(connector.connector) === connector.state) continue;
        lastStates.set(connector.connector, connector.state);
        options.log(`[channels] ${connectorLabel({ ...status, connectors: [connector] })}`);
      }
      const fresh = status.recentDenials.filter((denial) => denial.seq > highWater);
      if (fresh.length > 0) {
        highWater = Math.max(highWater, ...fresh.map((denial) => denial.seq));
        for (const denial of fresh) {
          options.warn(
            `[channels] 拒绝来自 ${denial.sender} 的消息（${denial.chatId}）：ohs channels allow ${denial.sender}`,
          );
        }
      }
      await delay(backoff, signal);
    }
  } finally {
    try {
      await client.channels.stopRuntime();
      options.log("[channels] 已停止（临时）；重启 daemon 后 enabled 渠道会自动恢复。");
    } catch (error) {
      options.warn(
        `[channels] 停止渠道失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function maxDenialSeq(status: ChannelRuntimeStatus): number {
  return status.recentDenials.reduce((max, denial) => Math.max(max, denial.seq), -1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createDefaultRuntimeClient(): Promise<ChannelsRuntimeClientLike> {
  const { ensureLocalDaemon } = await import("../ensure-daemon.js");
  const daemon = await ensureLocalDaemon();
  const { OpenHarnessClient } = await import("@openharness/client");
  return new OpenHarnessClient({ baseUrl: daemon.url, token: daemon.token });
}

async function runChannelsServe(): Promise<void> {
  const client = await createDefaultRuntimeClient();
  const controller = new AbortController();
  let stopping = false;
  const shutdown = () => {
    if (stopping) {
      console.error("\n[channels] 强制退出。");
      process.exit(130);
    }
    stopping = true;
    console.log("\n[channels] 正在停止…(再按一次 Ctrl+C 强制退出)");
    controller.abort();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await followChannelRuntime({
      client,
      signal: controller.signal,
      log: (message) => console.log(message),
      warn: (message) => console.warn(message),
    });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

async function runChannelsStatus(): Promise<void> {
  const { readDaemonRegistry } = await import("@openharness/server");
  let daemon: ReturnType<typeof readDaemonRegistry>;
  try {
    daemon = readDaemonRegistry();
  } catch {
    daemon = undefined;
  }
  if (!daemon) {
    console.log("daemon: not running；无法读取渠道配置");
    return;
  }
  const { OpenHarnessClient } = await import("@openharness/client");
  const client = new OpenHarnessClient({ baseUrl: daemon.url, token: daemon.token });
  try {
    await client.protocol.health();
    const feishu = await client.channels.getFeishu();
    const runtime = await client.channels.runtimeStatus();
    const connector = runtime.connectors.find((item) => item.connector === "feishu");
    const acl =
      feishu.allowFrom.length === 0
        ? "allowFrom empty — ALL DENIED"
        : `allowFrom: ${feishu.allowFrom.map((entry) => `${entry.name}(${entry.id})`).join(", ")}`;
    console.log(
      `feishu: ${feishu.configured ? (feishu.enabled ? "enabled" : "disabled") : "not configured"} (${acl})`,
    );
    console.log(
      `runtime: ${connector?.state ?? "unknown"}${connector?.lastError ? ` (${connector.lastError})` : ""}`,
    );
    if (feishu.botName) console.log(`bot: ${feishu.botName}`);
    const status = await client.channels.getStatus({ connector: "feishu", limit: 10 });
    console.log(
      `daemon: ready (${daemon.url}); conversations: ${status.conversations.length}; recent deliveries: ${status.deliveries.length}`,
    );
    for (const delivery of status.deliveries.slice(0, 5)) {
      console.log(
        `delivery ${delivery.id}: ${delivery.status}, chat=${delivery.chatId}, run=${delivery.runId}`,
      );
    }
  } catch (error) {
    console.log(
      `daemon: unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

export function createChannelsCommand(): Command {
  const cmd = new Command("channels").description("Chat channel bridge (feishu, …)");

  cmd
    .command("serve")
    .description("Start enabled channels in the daemon and follow their status (long-running)")
    .action(async () => {
      await runChannelsServe();
    });

  cmd
    .command("add")
    .description("Interactive onboarding for a channel (feishu)")
    .argument("<channel>", "channel to onboard (only feishu is supported)")
    .action(async (channel: string) => {
      if (channel !== "feishu") {
        console.error(`[channels] 暂不支持通道：${channel}（目前仅支持 feishu）。`);
        process.exitCode = 1;
        return;
      }
      const result = await runChannelsAddFeishu();
      if (!result.ok) process.exitCode = 1;
    });

  cmd
    .command("allow")
    .description("Add a feishu user/chat id to the allowFrom whitelist")
    .argument("<id>", "feishu open_id (ou_) or chat_id (oc_)")
    .option("--name <name>", "display name for the whitelist entry")
    .action(async (id: string, options: { name?: string }) => {
      const result = await runChannelsAllow(id, options.name);
      if (!result.ok) process.exitCode = 1;
    });

  cmd
    .command("status")
    .description("Show configured channels")
    .action(async () => {
      await runChannelsStatus();
    });

  return cmd;
}
