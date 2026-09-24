import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

import { VykorClient } from "@vykor/client"
import {
  discoverInstalledNativePlugins,
  loadNativePlugin,
  verifyInstalledNativePlugin,
} from "../../../../../../packages/plugins/src/index.js"
import { createDefaultPluginService } from "../../../../../../packages/server/src/application/default-services/plugin-service.js"
import { createServiceRoutes } from "../../../../../../packages/server/src/http/routes/service.js"
import { createSystemRoutes } from "../../../../../../packages/server/src/http/routes/system.js"
import { DesktopPluginService } from "./plugin-service"

const execFileAsync = promisify(execFile)
const exampleSource = fileURLToPath(
  new URL("../../../../../../examples/plugins/text-inspector/", import.meta.url)
)

let root: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vk-desktop-plugin-git-acceptance-"))
  previousConfigDir = process.env.VYKOR_CONFIG_DIR
  process.env.VYKOR_CONFIG_DIR = join(root, "config")
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR
  else process.env.VYKOR_CONFIG_DIR = previousConfigDir
  await rm(root, { recursive: true, force: true })
})

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const target = join(destination, entry.name)
    if (entry.isDirectory()) await copyDirectory(join(source, entry.name), target)
    else if (entry.isFile()) await copyFile(join(source, entry.name), target)
  }
}

async function createPluginRepository(): Promise<{ path: string; commit: string }> {
  const path = join(root, "repository")
  await copyDirectory(exampleSource, path)
  await execFileAsync("git", ["init"], { cwd: path, windowsHide: true })
  await execFileAsync("git", ["config", "user.name", "Vykor Acceptance"], {
    cwd: path,
    windowsHide: true,
  })
  await execFileAsync("git", ["config", "user.email", "acceptance@vykor.test"], {
    cwd: path,
    windowsHide: true,
  })
  await execFileAsync("git", ["add", "."], { cwd: path, windowsHide: true })
  await execFileAsync("git", ["commit", "-m", "test plugin"], { cwd: path, windowsHide: true })
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: path,
    windowsHide: true,
  })
  return { path, commit: stdout.trim() }
}

function resolverRoots(): Promise<string[]> {
  return readdir(tmpdir()).then((entries) =>
    entries.filter((entry) => entry.startsWith("vykor-plugin-git-")).sort()
  )
}

function createDesktopService(): DesktopPluginService {
  const pluginService = createDefaultPluginService({
    current: {
      model: "acceptance-test",
      apiFormat: "anthropic",
      maxTurns: 1,
      permission: { mode: "default" },
    },
  })
  const routes = createServiceRoutes({
    pluginService,
    control: {
      acquireGlobalMutation: () => ({ release: () => {} }),
      acquireCwdMutation: () => ({ release: () => {} }),
      closeAllRuntimes: async () => {},
      closeRuntimesForCwd: async () => {},
      runtimeInspectionAvailable: false,
      inspectRuntimeHooks: async () => [],
      sessionExists: () => false,
    },
  })
  routes.route(
    "/",
    createSystemRoutes({
      control: {
        acquireGlobalMutation: () => undefined,
        closeAllRuntimes: async () => {},
        invalidateRuntimes: async () => {},
        runtimeSnapshot: () => {
          throw new Error("Runtime snapshot is outside this Git acceptance test")
        },
        inspectRun: () => undefined,
        listProjectionDiagnostics: () => {
          throw new Error("Projection diagnostics are outside this Git acceptance test")
        },
      },
    })
  )
  const client = new VykorClient({
    baseUrl: "http://desktop-git.test",
    fetch: async (input, init) => await routes.request(input, init),
  })
  return new DesktopPluginService({ daemonClient: async () => client })
}

describe("Desktop Native Git import acceptance", () => {
  it("installs a real local Git repository at a fixed commit and loads its immutable snapshot", async () => {
    const repository = await createPluginRepository()
    const resolverRootsBefore = await resolverRoots()

    const result = await createDesktopService().importGit({
      cwd: root,
      url: pathToFileURL(repository.path).href,
      ref: repository.commit,
    })

    expect(result.status, JSON.stringify(result)).toBe("installed")
    if (result.status !== "installed") throw new Error("Expected the Git Native plugin to install")
    expect(result.snapshot?.plugins.map((plugin) => plugin.identity.id)).toContain(
      "example.text-inspector"
    )
    const rendererJson = JSON.stringify(result)
    expect(rendererJson).not.toContain(repository.path)
    expect(rendererJson).not.toContain(repository.commit)

    await rm(repository.path, { recursive: true, force: true })
    const records = await discoverInstalledNativePlugins({ cwd: root })
    expect(records.map((record) => record.id)).toEqual(["example.text-inspector"])
    expect(records[0]).not.toHaveProperty("linkedSourcePath")
    await expect(stat(join(records[0]!.cachePath, ".git"))).rejects.toThrow()

    const verified = await verifyInstalledNativePlugin(records[0]!)
    expect(verified.status).toBe("valid")
    if (verified.status !== "valid") throw new Error("Expected the installed snapshot to verify")
    const loaded = await loadNativePlugin(verified.plugin)
    expect(loaded.components.skills?.value).toHaveLength(1)
    expect(loaded.components.tools?.value).toMatchObject([
      { declaredEntry: "./tools/index.mjs", runtime: "node" },
    ])
    expect(await resolverRoots()).toEqual(resolverRootsBefore)
  }, 30_000)
})
