import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { resolveWorkspaceOpenTarget } from "./workspace-path"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("resolveWorkspaceOpenTarget", () => {
  it("rejects openWith when rootPath is missing", async () => {
    await expect(
      resolveWorkspaceOpenTarget("C:\\Windows\\notepad.exe", undefined, {
        projectRoot: "E:\\code\\vykor",
        configDir: "C:\\Users\\ruanz\\.vykor",
        skillsDir: "C:\\Users\\ruanz\\.vykor\\skills",
        userProfilePath: "C:\\Users\\ruanz\\.vykor\\USER.md",
        outsideProjectRoot: "C:\\Users\\ruanz\\Documents\\Vykor",
      })
    ).rejects.toThrow("项目路径不能为空。")
  })

  it("allows a skill path when rootPath is the current project", async () => {
    const projectRoot = await createTemporaryDirectory()
    const configDir = await createTemporaryDirectory()
    const skillPath = join(configDir, "skills", "show-me", "SKILL.md")
    await mkdir(join(configDir, "skills", "show-me"), { recursive: true })
    await writeFile(skillPath, "# skill\n")

    const target = await resolveWorkspaceOpenTarget(skillPath, projectRoot, {
      projectRoot,
      configDir,
      skillsDir: join(configDir, "skills"),
      userProfilePath: join(configDir, "USER.md"),
      outsideProjectRoot: "",
    })
    expect(target.path).toBe(await realpath(skillPath))
    expect(target.isDirectory).toBe(false)
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vykor-opener-"))
  temporaryDirectories.push(path)
  return path
}
