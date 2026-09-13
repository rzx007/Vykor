import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { PluginPreparationStatus } from "../plugin-preparation-status"
import type { DesktopSessionPart, DesktopSessionView } from "@shared/session-types"

const view: DesktopSessionView = {
  cursor: 1, syncStatus: "connected",
  session: { id: "session-a", cwd: "/repo", title: "Review", model: "model", status: "running", metadata: {}, createdAt: 1, updatedAt: 1 },
  runs: [{ id: "run-a", sessionId: "session-a", inputId: "input-a", status: "pending", metadata: { pluginId: "dev.quality" }, createdAt: 1, updatedAt: 1 }],
  inputs: [{ id: "input-a", sessionId: "session-a", seq: 1, delivery: "queue", content: "@Quality review", items: [{ type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" }], attachments: [], metadata: {}, createdAt: 1 }],
  permissions: [],
  messages: [], parts: [], tasks: [],
}
const running: DesktopSessionView = {
  ...view,
  runs: [{ ...view.runs[0]!, status: "running" }],
  messages: [{ id: "user-a", sessionId: "session-a", inputId: "input-a", runId: "run-a", role: "user", seq: 1, metadata: {}, createdAt: 1, updatedAt: 1 }],
  parts: [{ id: "user-text", sessionId: "session-a", messageId: "user-a", seq: 1, type: "text", text: "@Quality review", status: "completed", metadata: {}, createdAt: 1, updatedAt: 1 }],
}
function render(state = view, activeSessionId = "session-a") {
  return renderToStaticMarkup(createElement(PluginPreparationStatus, { activeSessionId, view: state }))
}
it.each(["pending", "running"] as const)("shows preparation for %s even when the Run already has user text", (phase) => {
  const html = render(phase === "pending" ? view : running)
  expect(html).toContain("Quality")
  expect(html).toContain('data-session-id="session-a"')
  expect(html).toContain('data-run-id="run-a"')
  expect(html).toContain('data-plugin-id="dev.quality"')
})
it.each(["text", "reasoning", "tool", "tool_result"] as const)("ends preparation once assistant %s is projected", (type) => {
  const output: DesktopSessionPart = { id: "output", sessionId: "session-a", messageId: "assistant-a", seq: 1, type, text: "output", status: "running", metadata: {}, createdAt: 2, updatedAt: 2 }
  expect(render({
    ...running,
    messages: [...running.messages, { id: "assistant-a", sessionId: "session-a", runId: "run-a", role: "assistant", seq: 2, metadata: {}, createdAt: 2, updatedAt: 2 }],
    parts: [...running.parts, output],
  })).toBe("")
})
it.each(["running", "completed"] as const)("ends preparation when a Child task is %s", (status) => {
  expect(render({ ...running, tasks: [{ id: "child-task", sessionId: "session-a", runId: "run-a", childSessionId: "child-a", type: "agent", status, description: "Review", cwd: "/repo", metadata: {}, createdAt: 2, updatedAt: 2 }] })).toBe("")
})
it("ignores output from other runs and empty assistant envelopes", () => {
  expect(render({
    ...running,
    messages: [
      ...running.messages,
      { id: "assistant-empty", sessionId: "session-a", runId: "run-a", role: "assistant", seq: 2, metadata: {}, createdAt: 2, updatedAt: 2 },
      { id: "assistant-old", sessionId: "session-a", runId: "run-old", role: "assistant", seq: 3, metadata: {}, createdAt: 2, updatedAt: 2 },
    ],
    parts: [...running.parts, { id: "old-output", sessionId: "session-a", messageId: "assistant-old", seq: 1, type: "text", text: "old", status: "completed", metadata: {}, createdAt: 2, updatedAt: 2 }],
  })).toContain("Quality")
})
it("hides preparation for a different session or a terminal Run", () => {
  expect(render(running, "session-b")).toBe("")
  expect(render({ ...running, runs: [{ ...running.runs[0]!, status: "failed" }] })).toBe("")
})
