import type {
  ChannelRuntimeServiceOptions,
  ConnectorRuntimeHandle,
  CreateConnectorRuntimeInput,
} from "./channel-runtime-types.js";

/** Build the concrete channel adapter and durable bridge; the service owns their lifecycle. */
export async function createDefaultChannelRuntime(
  input: CreateConnectorRuntimeInput,
  logger: ChannelRuntimeServiceOptions["logger"],
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
      logger?.({
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
      logger?.({
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
