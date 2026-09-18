import { Command } from "commander";
import type { Settings, ChannelsConfig } from "@openharness/core";
import type { ChannelAdapter } from "@openharness/channels";
import { ChannelCredentialStore } from "@openharness/auth";

/**
 * `ohs channels` 子命令（D.2，TS 自有接线——Python 的 manager/bridge
 * 是库，消费方 ohmo 不移植，TS 按 swarm 既例直接接进 CLI）。
 *
 * serve：长驻进程。settings.channels 组装 adapters → MessageBus +
 * ChannelManager + ChannelBridge 跑通「通道消息 → 引擎 → 回复」，
 * SIGINT/SIGTERM 优雅退出。
 */

export interface AssembledChannels {
  adapters: ChannelAdapter[];
  /** 按通道名的 ACL 白名单（交给 manager 集中过滤，fail-closed）。 */
  allowFrom: Record<string, string[]>;
  accountIds: Record<string, string>;
  warnings: string[];
}

/** 按 settings.channels 组装启用的 adapter 实例（纯组装，不连接）。 */
export async function assembleChannelAdapters(
  channels: ChannelsConfig | undefined,
  credentials: ChannelCredentialStore = new ChannelCredentialStore(),
): Promise<AssembledChannels> {
  const adapters: ChannelAdapter[] = [];
  const allowFrom: Record<string, string[]> = {};
  const warnings: string[] = [];
  const accountIds: Record<string, string> = {};

  const feishu = channels?.feishu;
  if (feishu?.enabled) {
    const appSecret = feishu.appId ? await credentials.get(feishu.appId) : undefined;
    if (!feishu.appId || !appSecret) {
      warnings.push("feishu 已启用但缺凭据，请先运行 ohs channels add feishu。");
    } else {
      const { FeishuAdapter } = await import("@openharness/channels");
      adapters.push(
        new FeishuAdapter({
          appId: feishu.appId,
          appSecret,
          domain: feishu.domain,
          replyAtBotNames: feishu.replyAtBotNames,
          // ACL 不传给 adapter——集中在 ChannelManager（fail-closed）。
        }),
      );
      allowFrom["feishu"] = Object.values(feishu.allowFrom ?? {});
      accountIds["feishu"] = feishu.appId;
    }
  }

  return { adapters, allowFrom, accountIds, warnings };
}

async function runChannelsServe(): Promise<void> {
  const { loadSettings } = await import("@openharness/core");
  const settings: Settings = await loadSettings({});

  const { adapters, allowFrom, accountIds, warnings } = await assembleChannelAdapters(settings.channels);
  for (const w of warnings) console.warn(`[channels] ${w}`);
  if (adapters.length === 0) {
    console.error(
      "[channels] 没有启用任何通道。在 settings.json 配置 channels.feishu（enabled/appId/allowFrom），并运行 ohs channels add feishu 写入凭据。",
    );
    process.exitCode = 1;
    return;
  }

  if (!settings.model) throw new Error("channels serve requires a configured model");
  const { ensureLocalDaemon } = await import("../ensure-daemon.js");
  const daemon = await ensureLocalDaemon();
  const { OpenHarnessClient } = await import("@openharness/client");
  const client = new OpenHarnessClient({ baseUrl: daemon.url, token: daemon.token });

  const { MessageBus, ChannelManager, DurableChannelBridge } = await import("@openharness/channels");
  const bus = new MessageBus();
  const manager = new ChannelManager(adapters, bus, {
    allowFrom,
    accountIds,
    sendProgress: settings.channels?.sendProgress,
    sendToolHints: settings.channels?.sendToolHints,
    onWarning: (w) => console.warn(`[channels] ${w}`),
    onDeliveryResult: async ({ deliveryId, status, error }) => {
      await client.channels.recordDelivery(deliveryId, { status, error });
    },
  });
  const bridge = new DurableChannelBridge({
    application: {
      handleChannelMessage: (input, opts) => client.channels.handleMessage(input, opts),
      listPendingChannelDeliveries: (opts) => client.channels.listPendingDeliveries(opts),
      recordChannelDelivery: (id, input) => client.channels.recordDelivery(id, input),
    },
    bus,
    cwd: process.cwd(),
    model: settings.model,
    connectors: adapters.map((adapter) => adapter.name),
    onWarning: (w) => console.warn(`[channels] ${w}`),
  });

  let removeSignalHandlers = () => {};
  try {
    bridge.start();
    await manager.startAll();

    const status = manager.getStatus();
    for (const [name, s] of Object.entries(status)) {
      console.log(
        `[channels] ${name}: ${s.running ? "running" : `failed${s.lastError ? ` (${s.lastError})` : ""}`}`,
      );
    }
    if (Object.values(status).every((s) => !s.running)) {
      console.error("[channels] 所有通道启动失败，退出。");
      process.exitCode = 1;
      return;
    }
    console.log(`[channels] 已连接 daemon ${daemon.url}，桥接已就绪，Ctrl+C 退出。`);

    await new Promise<void>((resolve) => {
      let stopping = false;
      const shutdown = () => {
        if (stopping) {
          console.error("\n[channels] 强制退出。");
          process.exit(130);
        }
        stopping = true;
        console.log("\n[channels] 正在停止…(再按一次 Ctrl+C 强制退出)");
        resolve();
      };
      removeSignalHandlers = () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  } finally {
    const failures: unknown[] = [];
    for (const cleanup of [
      () => bridge.stop(),
      () => manager.stopAll(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    removeSignalHandlers();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Channel shutdown failed");
  }
}

export function createChannelsCommand(): Command {
  const cmd = new Command("channels").description("Chat channel bridge (feishu, …)");

  cmd
    .command("serve")
    .description("Start enabled channels and bridge them to the agent (long-running)")
    .action(async () => {
      await runChannelsServe();
    });

  cmd
    .command("status")
    .description("Show configured channels")
    .action(async () => {
      const { loadSettings } = await import("@openharness/core");
      const settings: Settings = await loadSettings({});
      const feishu = settings.channels?.feishu;
      if (!feishu) {
        console.log("channels: (none configured)");
        return;
      }
      const entries = Object.entries(feishu.allowFrom ?? {});
      const acl =
        entries.length === 0
          ? "allowFrom empty — ALL DENIED"
          : `allowFrom: ${entries.map(([n, id]) => `${n}(${id})`).join(", ")}`;
      console.log(`feishu: ${feishu.enabled ? "enabled" : "disabled"} (${acl})`);
      const { readDaemonRegistry } = await import("@openharness/server");
      const daemon = readDaemonRegistry();
      if (!daemon) {
        console.log("daemon: not running; conversation mappings unavailable");
        return;
      }
      try {
        const { OpenHarnessClient } = await import("@openharness/client");
        const client = new OpenHarnessClient({
          baseUrl: daemon.url,
          token: daemon.token,
        });
        await client.protocol.health();
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
    });

  return cmd;
}
