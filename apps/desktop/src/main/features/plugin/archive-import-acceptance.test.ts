import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import JSZip from "jszip"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

import { VykorClient } from "@vykor/client"
import {
  discoverInstalledNativePlugins,
  loadNativePlugin,
  readInstalledPluginStore,
  verifyInstalledNativePlugin,
} from "../../../../../../packages/plugins/src/index.js"
import { createDefaultPluginService } from "../../../../../../packages/server/src/application/default-services/plugin-service.js"
import { createServiceRoutes } from "../../../../../../packages/server/src/http/routes/service.js"
import { createSystemRoutes } from "../../../../../../packages/server/src/http/routes/system.js"
import { DesktopPluginService } from "./plugin-service"

const exampleSource = fileURLToPath(
  new URL("../../../../../../examples/plugins/text-inspector/", import.meta.url)
)

let root: string
let scopedTmpdir: string
let previousConfigDir: string | undefined
let previousTempEnv: { TEMP?: string; TMP?: string; TMPDIR?: string }

beforeEach(async () => {
  // 解析器把临时目录建在 os.tmpdir() 下，而它是全局共享的；这里把本用例的
  // 临时目录收窄到独立作用域，避免与其它并行运行的包互相看到对方的残留目录。
  scopedTmpdir = await mkdtemp(join(tmpdir(), "vk-desktop-plugin-tmp-"))
  previousTempEnv = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  }
  process.env.TEMP = scopedTmpdir
  process.env.TMP = scopedTmpdir
  process.env.TMPDIR = scopedTmpdir
  root = await mkdtemp(join(tmpdir(), "vk-desktop-plugin-archive-"))
  previousConfigDir = process.env.VYKOR_CONFIG_DIR
  process.env.VYKOR_CONFIG_DIR = join(root, "config")
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR
  else process.env.VYKOR_CONFIG_DIR = previousConfigDir
  if (previousTempEnv.TEMP === undefined) delete process.env.TEMP
  else process.env.TEMP = previousTempEnv.TEMP
  if (previousTempEnv.TMP === undefined) delete process.env.TMP
  else process.env.TMP = previousTempEnv.TMP
  if (previousTempEnv.TMPDIR === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTempEnv.TMPDIR
  await rm(root, { recursive: true, force: true })
  await rm(scopedTmpdir, { recursive: true, force: true })
})

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const target = join(destination, entry.name)
    if (entry.isDirectory()) await copyDirectory(join(source, entry.name), target)
    else if (entry.isFile()) await copyFile(join(source, entry.name), target)
  }
}

async function addDirectoryToZip(zip: JSZip, source: string, prefix = ""): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = join(source, entry.name)
    if (entry.isDirectory()) await addDirectoryToZip(zip, path, relativePath)
    else if (entry.isFile()) zip.file(relativePath, await readFile(path))
  }
}

async function packageTextInspector(): Promise<{ archivePath: string; sourcePath: string }> {
  const sourcePath = join(root, "source")
  const archivePath = join(root, "text-inspector.zip")
  await copyDirectory(exampleSource, sourcePath)
  const zip = new JSZip()
  await addDirectoryToZip(zip, sourcePath)
  await writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))
  return { archivePath, sourcePath }
}

function resolverRoots(): Promise<string[]> {
  return readdir(tmpdir()).then((entries) => entries.filter((entry) => entry.startsWith("oh-plugin-zip-")).sort())
}

function createDesktopService(archivePath: string): DesktopPluginService {
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
  routes.route("/", createSystemRoutes({
    control: {
      acquireGlobalMutation: () => undefined,
      closeAllRuntimes: async () => {},
      invalidateRuntimes: async () => {},
      runtimeSnapshot: () => { throw new Error("Runtime snapshot is outside this archive test") },
      inspectRun: () => undefined,
      listProjectionDiagnostics: () => { throw new Error("Projection diagnostics are outside this archive test") },
    },
  }))
  const client = new VykorClient({
    baseUrl: "http://desktop-archive.test",
    fetch: async (input, init) => await routes.request(input, init),
  })
  return new DesktopPluginService({
    chooseArchive: async () => archivePath,
    daemonClient: async () => client,
  })
}

describe("Desktop Native ZIP archive import acceptance", () => {
  it("installs the real text-inspector ZIP through Desktop and loads the immutable snapshot after source removal", async () => {
    const { archivePath, sourcePath } = await packageTextInspector()
    const resolverRootsBefore = await resolverRoots()

    const result = await createDesktopService(archivePath).importArchive({} as never, { cwd: root })

    expect(result.status).toBe("installed")
    if (result.status !== "installed") throw new Error("Expected the permission-free Native ZIP to install")
    expect(result.snapshot?.plugins.map((plugin) => plugin.identity.id)).toContain("example.text-inspector")
    const rendererJson = JSON.stringify(result)
    expect(rendererJson).not.toContain(archivePath)
    expect(rendererJson).not.toMatch(/\b[a-f0-9]{64}\b/i)
    await rm(archivePath, { force: true })
    await rm(sourcePath, { recursive: true, force: true })
    const records = await discoverInstalledNativePlugins({ cwd: root })
    expect(records.map((record) => record.id)).toEqual(["example.text-inspector"])
    expect(records[0]?.cachePath).not.toMatch(/\.zip$/i)
    expect(records[0]).not.toHaveProperty("linkedSourcePath")
    const verified = await verifyInstalledNativePlugin(records[0]!)
    expect(verified.status).toBe("valid")
    if (verified.status !== "valid") throw new Error("Expected the installed cache snapshot to verify")
    const loaded = await loadNativePlugin(verified.plugin)
    expect(loaded.components.skills?.value).toHaveLength(1)
    expect(loaded.components.tools?.value).toMatchObject([
      { declaredEntry: "./tools/index.mjs", runtime: "node" },
    ])
    expect(await resolverRoots()).toEqual(resolverRootsBefore)
  }, 30_000)

  it("returns a safe structured failure for an invalid ZIP without creating an installed record or resolver residue", async () => {
    const archivePath = join(root, "invalid.zip")
    await writeFile(archivePath, "not a ZIP")
    const resolverRootsBefore = await resolverRoots()

    const result = await createDesktopService(archivePath).importArchive({} as never, { cwd: root })

    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("Expected an invalid ZIP to fail")
    expect(result.details).toContainEqual({ code: "plugin_archive_resolution_failed" })
    const rendererJson = JSON.stringify(result)
    expect(rendererJson).not.toContain(archivePath)
    expect(rendererJson).not.toMatch(/\b[a-f0-9]{64}\b/i)
    expect((await readInstalledPluginStore(join(root, "config", "plugins", "installed.json"))).plugins).toEqual({})
    expect(await resolverRoots()).toEqual(resolverRootsBefore)
  })
})
