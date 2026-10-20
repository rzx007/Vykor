import { expect, it } from "vitest"

import { projectMenuItems } from "../project-menu-items"

it("does not offer a per-project default shell action", () => {
  const labels = projectMenuItems(false).map((item) => item.label)
  expect(labels).not.toContain("设置默认 Shell")
  expect(projectMenuItems(false).map((item) => item.id)).not.toContain("set-default-shell")
  expect(labels).toEqual([
    "置顶项目",
    "在资源管理器中打开",
    "重新绑定目录",
    "重命名项目",
    "从列表移除",
  ])
})
