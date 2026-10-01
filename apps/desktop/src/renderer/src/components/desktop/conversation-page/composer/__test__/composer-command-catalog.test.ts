import { describe, expect, it } from "vitest"

import type { DesktopCommandCatalogEntry } from "@shared/session-types"
import { pickerItems } from "../composer-picker-model"
import { toComposerCommands } from "../composer-command-catalog"

const catalog: DesktopCommandCatalogEntry[] = ["compact", "goal", "status", "skills"].map((id) => ({
  name: `/${id}`,
  displayName: id,
  description: "English description",
  kind: "session",
  source: "builtin",
  selection: "execute",
  requiresEmptyComposer: true,
}))
const context = {
  hasSession: true,
  running: false,
  canOpenReview: true,
  pinned: false,
  permissionMode: "default" as const,
  hasModels: true,
  hasEffortTiers: true,
}

describe("desktop slash commands", () => {
  it("uses Chinese labels and descriptions without changing command identities", () => {
    const commands = toComposerCommands(catalog, context)
    expect(commands.find((item) => item.id === "compact")).toMatchObject({
      label: "压缩上下文",
      command: { id: "compact", title: "压缩上下文" },
    })
    expect(commands.find((item) => item.id === "goal")?.label).toBe("目标")
    expect(commands.find((item) => item.id === "status")?.label).toBe("状态")
    expect(commands.find((item) => item.id === "skills")?.label).toBe("技能与插件")
    expect(commands.every((item) => /[\u3400-\u9fff]/.test(item.description))).toBe(true)
  })

  it("adds shortcuts backed by existing desktop controls and session actions", () => {
    const ids = toComposerCommands(catalog, context).map((item) => item.id)
    for (const id of ["new", "model", "effort", "plan", "diff", "pin", "rename", "fork"]) {
      expect(ids).toContain(id)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("hides session-only commands from drafts and unsupported controls from the menu", () => {
    const ids = toComposerCommands(catalog, {
      ...context,
      hasSession: false,
      canOpenReview: false,
      hasModels: false,
      hasEffortTiers: false,
    }).map((item) => item.id)
    for (const id of ["compact", "new", "pin", "rename", "fork", "diff", "model", "effort"]) {
      expect(ids).not.toContain(id)
    }
    expect(ids).toContain("plan")
    expect(ids).toContain("goal")
    const running = toComposerCommands(catalog, { ...context, running: true }).map(
      (item) => item.id
    )
    expect(running).not.toContain("compact")
    expect(running).not.toContain("fork")
    expect(running).toContain("new")
  })

  it("searches translated names using both Chinese queries and English slash names", () => {
    const commands = toComposerCommands(catalog, context)
    for (const query of ["model", "切换模型"]) {
      expect(
        pickerItems({ trigger: { sigil: "/", mode: "leading", query }, commands, skills: [] }).map(
          (item) => item.id
        )
      ).toEqual(["model"])
    }
    expect(
      pickerItems({
        trigger: { sigil: "/", mode: "leading", query: "模型" },
        commands,
        skills: [],
      })[0]?.id
    ).toBe("model")
    expect(
      pickerItems({
        trigger: { sigil: "/", mode: "leading", query: "compact" },
        commands,
        skills: [],
      }).map((item) => item.id)
    ).toEqual(["compact"])
  })

  it("shows the inverse action when the chat is pinned or in plan mode", () => {
    const commands = toComposerCommands(catalog, {
      ...context,
      pinned: true,
      permissionMode: "plan",
    })
    expect(commands.find((item) => item.id === "pin")?.label).toBe("取消置顶")
    expect(commands.find((item) => item.id === "plan")?.label).toBe("退出计划模式")
  })

  it("never advertises a server command without a desktop adapter", () => {
    expect(
      toComposerCommands(
        [
          ...catalog,
          {
            name: "/unsupported",
            kind: "session",
            selection: "execute",
            requiresEmptyComposer: true,
          },
        ],
        context
      ).map((item) => item.id)
    ).not.toContain("unsupported")
  })
})
