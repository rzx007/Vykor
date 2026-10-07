import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { gitService } from "./git-service"

const execFileAsync = promisify(execFile)

let repoRoot: string
let plainDir: string
let previousGitCeiling: string | undefined

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "oh-git-probe-"))
  previousGitCeiling = process.env.GIT_CEILING_DIRECTORIES
  process.env.GIT_CEILING_DIRECTORIES = base
  repoRoot = join(base, "repo")
  plainDir = join(base, "plain")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(repoRoot, { recursive: true })
  await mkdir(plainDir, { recursive: true })
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoRoot })
  await writeFile(join(plainDir, "readme.txt"), "not a repo", "utf8")
})

afterAll(async () => {
  if (previousGitCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
  else process.env.GIT_CEILING_DIRECTORIES = previousGitCeiling
  if (repoRoot) await rm(join(repoRoot, ".."), { recursive: true, force: true })
})

describe("gitService.isRepository", () => {
  it("reports true and the repository root for a git working tree", async () => {
    await expect(gitService.isRepository({ path: repoRoot })).resolves.toEqual({
      isRepository: true,
      rootPath: expect.any(String),
    })
  })

  it("reports true from a subdirectory inside the repository", async () => {
    const { mkdir } = await import("node:fs/promises")
    const nested = join(repoRoot, "packages", "app")
    await mkdir(nested, { recursive: true })

    const result = await gitService.isRepository({ path: nested })

    expect(result.isRepository).toBe(true)
    expect(result.rootPath?.replace(/\\/g, "/").toLowerCase()).toBe(
      repoRoot.replace(/\\/g, "/").toLowerCase()
    )
  })

  it("reports false without throwing for a directory that is not a repository", async () => {
    await expect(gitService.isRepository({ path: plainDir })).resolves.toEqual({
      isRepository: false,
      rootPath: null,
    })
  })

  it("reports false without throwing for a missing directory", async () => {
    await expect(gitService.isRepository({ path: join(plainDir, "missing") })).resolves.toEqual({
      isRepository: false,
      rootPath: null,
    })
  })

  it("reports false without throwing when the path points at a file", async () => {
    await expect(gitService.isRepository({ path: join(plainDir, "readme.txt") })).resolves.toEqual({
      isRepository: false,
      rootPath: null,
    })
  })

  it("reports false without throwing for an empty path", async () => {
    await expect(gitService.isRepository({ path: "   " })).resolves.toEqual({
      isRepository: false,
      rootPath: null,
    })
  })
})

describe("gitService.fileDiff path containment", () => {
  it("ignores whitespace only for display and applies staged/unstaged scopes", async () => {
    await execFileAsync("git", ["config", "user.name", "Git Test"], { cwd: repoRoot })
    await execFileAsync("git", ["config", "user.email", "git@example.com"], { cwd: repoRoot })
    await writeFile(join(repoRoot, "spaces.txt"), "hello world\n")
    await execFileAsync("git", ["add", "spaces.txt"], { cwd: repoRoot })
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: repoRoot })
    await writeFile(join(repoRoot, "spaces.txt"), "hello   world\n")
    expect(
      (await gitService.changes({ rootPath: repoRoot, ignoreWhitespace: true })).files
    ).toEqual([])
    expect(
      (
        await gitService.fileDiff({
          rootPath: repoRoot,
          path: "spaces.txt",
          ignoreWhitespace: true,
        })
      ).patch
    ).toBe("(no diff)")
    expect((await gitService.fileDiff({ rootPath: repoRoot, path: "spaces.txt" })).patch).toContain(
      "+hello   world"
    )
    await execFileAsync("git", ["add", "spaces.txt"], { cwd: repoRoot })
    expect((await gitService.changes({ rootPath: repoRoot, scope: "staged" })).files).toHaveLength(
      1
    )
    expect(
      (await gitService.changes({ rootPath: repoRoot, scope: "unstaged" })).files
    ).toHaveLength(0)
  })
  it.each(["src/../../readme.txt", "src/./../../readme.txt", "src\\..\\..\\readme.txt"])(
    "rejects an untracked file outside the supplied project root: %s",
    async (path) => {
      const { mkdir } = await import("node:fs/promises")
      const projectRoot = join(plainDir, "project")
      await mkdir(join(projectRoot, "src"), { recursive: true })
      await expect(
        gitService.fileDiff({ rootPath: projectRoot, path, status: "untracked" })
      ).rejects.toThrow(/项目目录内/)
    }
  )

  it("reads a normalized project file from the saved root", async () => {
    const result = await gitService.fileDiff({
      rootPath: plainDir,
      path: "nested/../readme.txt",
      status: "untracked",
    })
    expect(result.path).toBe("readme.txt")
    expect(result.binary).toBe(false)
    expect(result.patch).toContain("+not a repo")
  })

  it("preserves the current tracked diff and repository root", async () => {
    const rootPath = fileURLToPath(new URL("../../../../../../", import.meta.url))
    const path = "apps/desktop/src/main/features/git/git-service.ts"
    const expected = await execFileAsync("git", ["diff", "HEAD", "--", path], { cwd: rootPath })
    const result = await gitService.fileDiff({ rootPath, path, status: "modified" })
    expect(result.path).toBe(path)
    expect(result.patch).toBe(expected.stdout || "(no diff)")
    const changes = await gitService.changes({ rootPath })
    expect(changes.rootPath).toBe(resolve(rootPath))
    if (expected.stdout) expect(changes.files.some((file) => file.path === path)).toBe(true)
  })
})
