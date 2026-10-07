import { describe, expect, it } from "vitest"
import { searchSettings } from "./settings-search"
import { settingsNavigation } from "./settings-navigation"
describe("real settings search", () => {
  it("finds implemented fields and passes a field target for direct navigation", () => {
    expect(searchSettings("禁止命令")).toContainEqual(expect.objectContaining({ section: "permissions", target: "permissions-deniedCommands" }))
    expect(searchSettings("ＷＳＬ 项目")).toContainEqual(expect.objectContaining({ section: "runtime" }))
    expect(searchSettings("机密 变量")).toContainEqual(expect.objectContaining({ section: "runtime" }))
  })
  it("indexes only real sections and never produces placeholder actions", () => {
    const slugs = new Set(settingsNavigation.map(item => item.slug))
    for (const term of ["Git", "诊断", "用量", "记忆", "终端", "备份"]) {
      const results = searchSettings(term)
      expect(results.length).toBeGreaterThan(0)
      expect(results.every(result => slugs.has(result.section))).toBe(true)
    }
    expect(searchSettings("   ")).toEqual([])
    expect(searchSettings("不存在的设置项")).toEqual([])
  })
})
