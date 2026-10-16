import { describe, expect, it } from "vitest"
import { pluginErrorMessage } from "./plugin-error"

describe("pluginErrorMessage", () => {
  it.each([
    new Error("Cannot uninstall plugins while session runs are active"),
    new Error("Error invoking remote method 'plugin:uninstall': VykorApiError: Cannot uninstall plugins while session runs are active"),
    "Error invoking remote method 'plugin:uninstall': Error: Cannot uninstall plugins while session runs are active",
  ])("explains that running tasks must finish before uninstalling", (error) => {
    expect(pluginErrorMessage(error)).toBe("当前有任务正在运行，请等待任务结束后再卸载插件。")
  })

  it.each([
    new Error("Error invoking remote method 'plugin:uninstall': VykorApiError: Plugin not found for user: example.plugin"),
    { message: "Error invoking remote method 'plugin:uninstall': Error: Plugin not found for user: example.plugin" },
  ])("removes transport wrappers while retaining the concrete reason", (error) => {
    expect(pluginErrorMessage(error)).toBe("Plugin not found for user: example.plugin")
  })

  it("preserves permission errors and supplies a fallback for missing messages", () => {
    expect(pluginErrorMessage(new Error("EPERM: access denied, installed.json"))).toBe("EPERM: access denied, installed.json")
    expect(pluginErrorMessage(null)).toBe("插件操作失败，未返回具体原因。")
  })
})
