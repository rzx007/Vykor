import { afterEach, describe, expect, it } from "vitest"
import {
  moveUtilityPanelScope,
  readUtilityPanelRuntimeState,
  resetUtilityPanelRuntimeStatesForTests,
  writeUtilityPanelRuntimeState,
} from "../utility-panel-repository"
import type { UtilityPanelRuntimeState } from "../utility-panel-state"
import { useCodePreviewDrafts } from "@renderer/components/desktop/tools/editor/code-preview-drafts"

afterEach(() => resetUtilityPanelRuntimeStatesForTests())

function runtimeState(marker: string): UtilityPanelRuntimeState {
  return {
    tabs: [],
    browserTabs: [],
    fileTabs: [],
    fileProjectPath: null,
    activeFilePath: marker,
    loadingFilePath: null,
    activeTabId: "",
    terminalMounted: false,
    handledFileRequestId: null,
    handledToolRequestId: null,
  }
}

describe("utility panel runtime state retention", () => {
  it("保留的 scope 数量有上限，不会随访问过的会话无限增长", () => {
    for (let index = 0; index < 20; index += 1)
      writeUtilityPanelRuntimeState(`session:s${index}`, runtimeState(`s${index}`))

    // 最早写入的 scope 已被淘汰，最近写入的仍可恢复。
    expect(readUtilityPanelRuntimeState("session:s0")).toBeUndefined()
    expect(readUtilityPanelRuntimeState("session:s19")?.activeFilePath).toBe("s19")
  })

  it("当前活动的 scope 反复写入会一直留在缓存里", () => {
    const active = "session:active"
    for (let index = 0; index < 20; index += 1) {
      writeUtilityPanelRuntimeState(active, runtimeState(`active-${index}`))
      writeUtilityPanelRuntimeState(`session:other-${index}`, runtimeState("other"))
    }

    expect(readUtilityPanelRuntimeState(active)?.activeFilePath).toBe("active-19")
  })

  it("移动 scope 时把运行时状态搬到目标 scope", () => {
    const fromKey = JSON.stringify(["draft:p1", "/project", "a.ts"])
    const toKey = JSON.stringify(["session:s1", "/project", "a.ts"])
    useCodePreviewDrafts.getState().begin(fromKey, "old")
    useCodePreviewDrafts.getState().change(fromKey, "unsaved")
    writeUtilityPanelRuntimeState("draft:p1", runtimeState("draft"))

    moveUtilityPanelScope("draft:p1", "session:s1", {})

    expect(readUtilityPanelRuntimeState("session:s1")?.activeFilePath).toBe("draft")
    expect(readUtilityPanelRuntimeState("draft:p1")).toBeUndefined()
    expect(useCodePreviewDrafts.getState().drafts[toKey]?.content).toBe("unsaved")
    expect(useCodePreviewDrafts.getState().drafts[fromKey]).toBeUndefined()
    useCodePreviewDrafts.setState({ drafts: {} })
  })

  it("目标 scope 已有运行时状态时，源 scope 仍然被回收", () => {
    writeUtilityPanelRuntimeState("session:s1", runtimeState("existing"))
    writeUtilityPanelRuntimeState("draft:p1", runtimeState("draft"))

    moveUtilityPanelScope("draft:p1", "session:s1", {})

    // 目标已有状态时不覆盖它，但源 scope 必须释放，否则会一直被留下。
    expect(readUtilityPanelRuntimeState("session:s1")?.activeFilePath).toBe("existing")
    expect(readUtilityPanelRuntimeState("draft:p1")).toBeUndefined()
  })
})
