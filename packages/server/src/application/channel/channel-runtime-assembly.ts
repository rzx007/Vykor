import { homedir } from "node:os";

import type { ChannelConfigStore } from "@vykor/auth";
import { resolveChannelWorkspaceRoot, type Settings } from "@vykor/core";

import { ChannelRuntimeService } from "../../daemon/channel-runtime-service.js";
import type { ObservabilityEvent } from "../../shared/observability.js";
import type { ChannelApplicationService } from "./channel-application-service.js";
import { ChannelOnboardingService } from "./channel-onboarding-service.js";

export function createDaemonChannelRuntime(input: {
  channelConfig: ChannelConfigStore;
  channels: ChannelApplicationService;
  getSettings?: () => Settings;
  settings?: Settings;
  outsideProjectWorkspaceRoot?: string;
  log: (event: ObservabilityEvent) => void;
}): { runtime: ChannelRuntimeService; onboarding: ChannelOnboardingService } {
  const { channelConfig, channels } = input;
  const runtime = new ChannelRuntimeService({
    application: {
      handleMessage: (message) => channels.handleMessage(message),
      pendingDeliveries: async (options) => channels.pendingDeliveries(options),
      recordDelivery: async (id, record) => channels.recordDelivery(id, record),
    },
    config: { getFeishu: () => channelConfig.getFeishu() },
    getSettings: () => input.getSettings?.() ?? input.settings,
    workspaceRoot: resolveChannelWorkspaceRoot({
      envDir: process.env.VYKOR_CHANNELS_DIR,
      outsideProjectWorkspaceRoot: input.outsideProjectWorkspaceRoot,
      homedir: homedir(),
    }),
    logger: input.log,
  });
  const onboarding = new ChannelOnboardingService({
    config: channelConfig,
    onConfigChanged: async () => {
      await runtime.applyFeishuConfig(await channelConfig.getFeishu());
    },
    readBotName: () => runtime.status().connectors.find(
      (connector) => connector.connector === "feishu",
    )?.botName,
    logger: input.log,
  });
  return { runtime, onboarding };
}
