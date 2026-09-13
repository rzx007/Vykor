import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import * as status from "../plugin-preparation-status"
import type { DesktopSessionView } from "@shared/session-types"

const view = {
  session: { id: "session-a" },
  runs: [{ id: "run-a", sessionId: "session-a", inputId: "input-a", status: "running", metadata: { pluginId: "dev.quality" } }],
  inputs: [{ id: "input-a", items: [{ type: "capability", kind: "plugin", pluginId: "dev.quality", displayName: "Quality" }] }],
  messages: [], parts: [], tasks: [],
} as unknown as DesktopSessionView
it("ties preparation to the session, run and plugin and hides it once tool output exists", () => {
  const render = (activeSessionId: string, state = view) => renderToStaticMarkup(createElement(status.PluginPreparationStatus, { activeSessionId, view: state }))
  const html = render("session-a")
  expect(html).toContain("Quality")
  expect(html).toContain('data-session-id="session-a"')
  expect(html).toContain('data-run-id="run-a"')
  expect(html).toContain('data-plugin-id="dev.quality"')
  expect(render("session-b")).toBe("")
  expect(render("session-a", { ...view, messages: [{ id: "message-a", runId: "run-a" }] as DesktopSessionView["messages"], parts: [{ messageId: "message-a", type: "tool" }] as DesktopSessionView["parts"] })).toBe("")
})
