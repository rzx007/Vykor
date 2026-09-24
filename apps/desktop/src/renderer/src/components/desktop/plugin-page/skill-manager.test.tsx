// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SkillManager, type SkillManagerProps } from "./skill-manager"

vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

const snapshot = {
  projects: [
    { name: "Vykor", path: "D:/Vykor" },
    { name: "Client", path: "D:/Client" },
    { name: "x10", path: "D:/Documents/Vykor/2026-09-09/x10" },
  ],
  warnings: [],
  skills: [
    {
      id: "builtin",
      name: "review",
      description: "Bundled review",
      content: "# Review",
      path: "",
      source: "bundled",
      readOnly: true,
    },
    {
      id: "agent",
      name: "agent-browser",
      description: "Agent folder",
      content: "# Agent",
      path: "D:/Vykor/.agents/skills/agent-browser/SKILL.md",
      source: "agent",
      readOnly: true,
      projectPath: "D:/Vykor",
      projectName: "Vykor",
    },
    {
      id: "project",
      name: "release",
      description: "Project release",
      content: "---\nname: release\ndescription: Project release\n---\n\n# Release",
      path: "D:/Client/.vykor/skills/release/SKILL.md",
      source: "project",
      readOnly: false,
      projectPath: "D:/Client",
      projectName: "Client",
    },
    {
      id: "standard",
      name: "archify",
      description: "Standard global skill",
      content: "# Archify",
      path: "C:/Users/dev/.agents/skills/archify/SKILL.md",
      source: "standard",
      readOnly: true,
    },
    {
      id: "personal",
      name: "docs",
      description: "Global docs",
      content: "---\nname: docs\ndescription: Global docs\n---\n\n# Docs",
      path: "C:/vk/skills/docs/SKILL.md",
      source: "personal",
      readOnly: false,
    },
    {
      id: "outside",
      name: "outside-work",
      description: "Temporary outside-project skill",
      content: "# Outside",
      path: "D:/Documents/Vykor/2026-09-09/x10/.vykor/skills/outside/SKILL.md",
      source: "project",
      readOnly: false,
      projectPath: "D:/Documents/Vykor/2026-09-09/x10",
      projectName: "x10",
    },
  ],
}

let root: Root
let host: HTMLDivElement
let props: SkillManagerProps
const api = {
  snapshot: vi.fn(async () => filteredSnapshot()),
  remove: vi.fn(async () => filteredSnapshot()),
}
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

async function render(): Promise<void> {
  await act(async () => {
    root.render(<SkillManager {...props} />)
  })
  await act(async () => {
    await Promise.resolve()
  })
}
async function click(node: Element | null | undefined): Promise<void> {
  expect(node).toBeTruthy()
  await act(async () => {
    node!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { skills: api },
  })
  vi.clearAllMocks()
  api.snapshot.mockImplementation(async () => filteredSnapshot())
  api.remove.mockImplementation(async () => filteredSnapshot())
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  props = {
    query: "",
    refreshRequest: 0,
    projectPath: "D:/Vykor",
    notify: vi.fn(),
  }
})
afterEach(() => {
  if (root) act(() => root.unmount())
  host?.remove()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("SkillManager filesystem management", () => {
  it("loads all real sources and offers standard separately from personal", async () => {
    await render()
    expect(api.snapshot).toHaveBeenCalledWith({ projectPath: "D:/Vykor" })
    expect(host.querySelector('[aria-label="已安装技能"]')?.textContent).toContain("agent-browser")
    expect(host.querySelector('[aria-label="已安装技能"]')?.textContent).toContain("docs")
    expect(host.querySelector('[aria-label="已安装技能"]')?.textContent).toContain("archify")
    expect([...host.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([
      "Vykor",
      "通用",
      "个人",
      "Client",
    ])
    expect(host.textContent).not.toContain("系统")
    expect(host.textContent).not.toContain("推荐")
    expect(host.textContent).not.toContain("创建技能")
    expect(host.textContent).not.toContain("x10")
    expect(host.textContent).not.toContain("outside-work")
  })

  it("filters project and VK global skills into their real categories", async () => {
    await render()
    await click(
      [...host.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Client")
    )
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain("release")
    expect(host.querySelector('[role="tabpanel"]')?.textContent).not.toContain("docs")
    await click(
      [...host.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "个人")
    )
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain("docs")
    expect(host.querySelector('[role="tabpanel"]')?.textContent).not.toContain("archify")
    await click(
      [...host.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "通用")
    )
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain("archify")
    expect(host.querySelector('[role="tabpanel"]')?.textContent).not.toContain("docs")
  })

  it("shows standard skills as read-only in details", async () => {
    await render()
    await click(host.querySelector('[aria-label*="archify"]'))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("通用 · 只读")
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("删除")
  })

  it("keeps bundled and agent-folder skills read-only in details", async () => {
    await render()
    await click(host.querySelector('[aria-label*="review"]'))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("内置 · 只读")
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("编辑技能")
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("卸载")
  })

  it("removes writable skills without offering editing", async () => {
    props = { ...props, projectPath: "D:/Client" }
    await render()
    await click(host.querySelector('[aria-label*="release"]'))
    expect(document.body.textContent).not.toContain("编辑技能")
    await click(
      [...document.querySelectorAll("button")].find((node) => node.textContent === "删除")
    )
    await click(
      [...document.querySelectorAll("button")].find((node) => node.textContent === "确认删除")
    )
    expect(api.remove).toHaveBeenCalledWith({
      id: "project",
      expectedContent: snapshot.skills[2].content,
      projectPath: "D:/Client",
    })
  })

  it("does not let an in-flight refresh restore a removed skill", async () => {
    let resolveRefresh!: (value: typeof snapshot) => void
    let resolveRemove!: (value: typeof snapshot) => void
    api.snapshot
      .mockImplementationOnce(async () => filteredSnapshot())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve
          })
      )
    api.remove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRemove = resolve
        })
    )
    props = { ...props, projectPath: "D:/Client" }
    await render()
    await click(host.querySelector('[aria-label*="release"]'))
    await click(
      [...document.querySelectorAll("button")].find((node) => node.textContent === "删除")
    )
    await click(
      [...document.querySelectorAll("button")].find((node) => node.textContent === "确认删除")
    )
    props = { ...props, refreshRequest: 1 }
    await render()
    await act(async () =>
      resolveRemove({
        ...snapshot,
        skills: snapshot.skills.filter((skill) => skill.id !== "project"),
      })
    )
    await act(async () => resolveRefresh(snapshot))
    expect(host.querySelector('[aria-label="已安装技能"]')?.textContent).not.toContain("release")
  })

  it("hides source tabs and keeps a short empty prompt when nothing is installed", async () => {
    api.snapshot.mockResolvedValueOnce({ projects: [], warnings: [], skills: [] })
    await render()

    expect(host.textContent).toContain("已安装")
    expect(host.textContent).toContain("还没有技能")
    expect(host.textContent).not.toContain("没有发现技能")
    expect(host.querySelector('[aria-label="技能来源"]')).toBeNull()
  })

  it("keeps source tabs when installed skills are filtered to an empty list", async () => {
    await render()
    props = { ...props, query: "does-not-exist" }
    await render()

    expect(host.querySelector('[aria-label="技能来源"]')).not.toBeNull()
    expect(host.textContent).toContain("没有匹配的技能")
    expect(host.textContent).not.toContain("还没有技能")
  })
})

function filteredSnapshot(): typeof snapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.filter((item) => item.name !== "x10"),
    skills: snapshot.skills.filter((skill) => {
      if (skill.source === "bundled" || skill.source === "personal") return true
      return pathKey(skill.projectPath ?? "") !== pathKey("D:/Documents/Vykor/2026-09-09/x10")
    }),
  }
}

function pathKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}
