import type { PluginUiInstanceRecord, PluginUiViewSnapshot } from "@vykor/client"
import type { DesktopSessionPart } from "@shared/session-types"
export const instanceId = "10000000-0000-4000-8000-000000000001"
export const mountId = "20000000-0000-4000-8000-000000000001"
export const instance: PluginUiInstanceRecord = {
  schemaVersion: 1,
  instanceId,
  sessionId: "session",
  sourceRunId: "source",
  sourcePartId: "part",
  sourceToolUseId: "use",
  sourceToolName: "Inspect",
  pluginId: "example.ui",
  pluginVersion: "1",
  pluginDigest: "a".repeat(64),
  componentId: "card",
  componentDigest: "b".repeat(64),
  title: "检查结果",
  surfaces: ["tool-result", "session-sidebar"],
  status: "open",
  revision: 1,
  data: { count: 1 },
  createdAt: 1,
  updatedAt: 1,
}
export const snapshot: PluginUiViewSnapshot = {
  instanceId,
  revision: 1,
  status: "open",
  data: { count: 1 },
  readOnly: false,
  actions: [{ id: "apply", label: "应用", completion: "keep-open" }],
  theme: "light",
  locale: "zh-CN",
  surface: "tool-result",
}
export const sourcePart: DesktopSessionPart = {
  id: "part",
  sessionId: "session",
  messageId: "message",
  seq: 1,
  type: "tool",
  toolUseId: "use",
  toolName: "Inspect",
  status: "completed",
  metadata: { pluginUi: instance },
  output: { content: [{ type: "text", text: "原始结果，不应消失" }] },
  createdAt: 1,
  updatedAt: 1,
}
