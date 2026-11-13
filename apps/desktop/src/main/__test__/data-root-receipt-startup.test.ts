import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it, vi } from "vitest"
const maintenance = vi.hoisted(() => vi.fn(async () => {}))
const normal = vi.hoisted(() => vi.fn())
const appendSwitch = vi.hoisted(() => vi.fn())
vi.mock("../data-root-maintenance", () => ({ startDataRootMaintenance: maintenance }))
vi.mock("../application", () => { normal(); return {} })
vi.mock("electron", () => ({ app: { isPackaged: false, commandLine: { appendSwitch }, getPath: (name: string) => join(process.env.USERPROFILE!, name), whenReady: async () => {}, exit: vi.fn() }, dialog: { showErrorBox: vi.fn() } }))
vi.mock("../core/linux-input-method", () => ({ configureLinuxInputMethod: () => {} }))
vi.mock("../features/workspace/document-preview-protocol", () => ({ registerDocumentPreviewScheme: () => {} }))
vi.mock("../features/plugin-apps/document-protocol", () => ({ registerPluginAppScheme: () => {} }))

it.each([false, true])("uses a retained host source only when canonical DB is absent; canonical=%s", async canonical => {
  vi.resetModules(); maintenance.mockClear(); normal.mockClear(); appendSwitch.mockClear()
  const home = await mkdtemp(join(tmpdir(), "desktop-retained-source-")), source = join(home, "source"), old = join(home, "old-data"), previousArgv = process.argv
  try {
    await mkdir(join(source, "data/desktop"), { recursive: true }); await mkdir(old)
    if (canonical) { await mkdir(join(source, "data/session-runtime")); await writeFile(join(source, "data/session-runtime/sessions.db"), "owned canonical bytes") }
    const sourceStat = await lstat(source), oldStat = await lstat(old)
    const host = { userDataDir: join(home, "userData"), documentsDir: join(home, "documents") }
    await writeFile(join(source, "data/desktop/legacy-import.json"), JSON.stringify({ version: 1, sources: {}, desktopScan: { version: 1, id: "host-scan", ...host, sources: {} },
      legacySources: { version: 1, status: "pending", sourceRoot: source, sourceIdentity: `${sourceStat.dev}:${sourceStat.ino}`, ...host,
        environment: { VYKOR_DATA_DIR: old }, identities: [{ path: old, identity: `${oldStat.dev}:${oldStat.ino}` }] } }))
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home); vi.stubEnv("VYKOR_CONFIG_DIR", source)
    vi.stubEnv("VYKOR_DATA_DIR", undefined); vi.stubEnv("VYKOR_CHANNELS_DIR", undefined); vi.stubEnv("VYKOR_IMAGE_ATTACHMENT_CACHE_DIR", undefined)
    process.argv = ["node", "desktop.ts"]
    await import("../index")
    if (process.platform === "linux") expect(appendSwitch).toHaveBeenCalledWith("enable-transparent-visuals")
    if (canonical) {
      await vi.waitFor(() => expect(normal).toHaveBeenCalledOnce(), { timeout: 30000 })
      expect(maintenance).not.toHaveBeenCalled()
      expect(await readFile(join(source, "data/session-runtime/sessions.db"), "utf8")).toBe("owned canonical bytes")
    } else {
      await vi.waitFor(() => expect(maintenance).toHaveBeenCalledOnce(), { timeout: 30000 })
      expect(normal).not.toHaveBeenCalled()
      await expect(readFile(join(source, "data/session-runtime/sessions.db"))).rejects.toMatchObject({ code: "ENOENT" })
    }
  } finally { process.argv = previousArgv; vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) }
})
