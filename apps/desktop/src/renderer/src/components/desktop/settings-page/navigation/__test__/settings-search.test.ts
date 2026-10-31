import { describe, expect, it } from "vitest"
import { searchSettings } from "../settings-search"
import { settingsNavigation } from "../settings-navigation"
describe("real settings search", () => {
  it("finds the message link browser preference by its choices", () => {
    for (const query of ["链接打开方式", "内置浏览器", "系统默认浏览器", "每次询问"]) {
      expect(searchSettings(query)).toContainEqual(
        expect.objectContaining({ section: "general", title: "消息链接打开方式" })
      )
    }
  })

  it("finds reply style choices separately from progress notifications", () => {
    for (const query of ["回复风格", "协作", "直接", "讲解"]) {
      expect(searchSettings(query)).toContainEqual(
        expect.objectContaining({ section: "general", title: "回复风格" })
      )
    }
    for (const query of ["进度通知", "关键节点", "必要时", "工作风格"]) {
      expect(searchSettings(query)).toContainEqual(
        expect.objectContaining({ section: "general", title: "进度通知" })
      )
    }
  })
  it("finds implemented fields and passes a field target for direct navigation", () => {
    expect(searchSettings("文件 网络 保护")).toContainEqual(
      expect.objectContaining({ section: "permissions", target: "permission-protection" })
    )
    expect(searchSettings("默认批准方式")).toContainEqual(
      expect.objectContaining({ section: "permissions", target: "general-permission-mode" })
    )
    expect(searchSettings("禁止命令")).toEqual([])
    expect(searchSettings("ＷＳＬ 项目")).toContainEqual(
      expect.objectContaining({ section: "runtime" })
    )
    expect(searchSettings("机密 变量")).toContainEqual(
      expect.objectContaining({ section: "runtime" })
    )
  })
  it("indexes only real sections and never produces placeholder actions", () => {
    const slugs = new Set(settingsNavigation.map((item) => item.slug))
    for (const term of ["Git", "诊断", "用量", "记忆", "终端", "备份"]) {
      const results = searchSettings(term)
      expect(results.length).toBeGreaterThan(0)
      expect(results.every((result) => slugs.has(result.section))).toBe(true)
    }
    expect(searchSettings("   ")).toEqual([])
    expect(searchSettings("不存在的设置项")).toEqual([])
  })
})
