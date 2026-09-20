/**
 * 渠道平台显示名。Desktop 渲染端在 `apps/desktop/src/shared/channel-types.ts`
 * 保留同一张表的副本（跨端不能共享运行时值，属有意重复）。
 */
const CHANNEL_CONNECTOR_LABELS: Record<string, string> = {
  feishu: "飞书",
  lark: "飞书（国际）",
};

export function channelConnectorLabel(connector: string): string {
  return CHANNEL_CONNECTOR_LABELS[connector.trim().toLowerCase()] ?? "其他平台";
}
