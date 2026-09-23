import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

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
