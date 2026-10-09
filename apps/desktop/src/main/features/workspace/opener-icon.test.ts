import { existsSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { execFileCalls, commandHandlers, getFileIcon, createFromPath } = vi.hoisted(() => ({
  execFileCalls: [] as Array<{ file: string; args: string[] }>,
  commandHandlers: new Map<string, (args: string[]) => string>(),
  getFileIcon: vi.fn(),
  createFromPath: vi.fn(),
}))

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void
  ): void => {
    execFileCalls.push({ file, args })
    const handler = commandHandlers.get(file)
    if (!handler) {
      callback(new Error(`unexpected command: ${file}`), "")
      return
    }
    try {
      callback(null, handler(args))
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)), "")
    }
  },
}))

vi.mock("electron", () => ({
  app: { getFileIcon },
  nativeImage: { createFromPath },
}))

import { readIconDataUrl } from "./opener-icon"

const PLIST_BUDDY = "/usr/libexec/PlistBuddy"
const originalPlatform = process.platform
const temporaryDirectories: string[] = []

beforeEach(() => {
  execFileCalls.length = 0
  commandHandlers.clear()
  getFileIcon.mockReset()
  createFromPath.mockReset()
  setPlatform("darwin")
})

afterEach(async () => {
  setPlatform(originalPlatform)
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("readIconDataUrl on macOS", () => {
  it("reads the declared icon and appends the missing .icns extension", async () => {
    const bundle = await createBundle("Cursor", { declaredIconFile: "Cursor" })
    stubPlistBuddy(bundle, "Cursor")
    stubSips()
    createFromPath.mockReturnValue(renderableImage())

    const dataUrl = await readIconDataUrl(bundle)

    expect(dataUrl).toBe(DATA_URL)
    expect(sipsArgs()).toContain(join(resourcesDir(bundle), "Cursor.icns"))
    expect(getFileIcon).not.toHaveBeenCalled()
  })

  it("uses the declared icon verbatim when it already points at an icns file", async () => {
    const bundle = await createBundle("GitHub Desktop", {
      declaredIconFile: "electron.icns",
      icnsFiles: { "electron.icns": 4096 },
    })
    stubPlistBuddy(bundle, "electron.icns")
    stubSips()
    createFromPath.mockReturnValue(renderableImage())

    await readIconDataUrl(bundle)

    expect(sipsArgs()).toContain(join(resourcesDir(bundle), "electron.icns"))
  })

  it("falls back to the largest icns and ignores default.icns", async () => {
    const bundle = await createBundle("Cursor", {
      declaredIconFile: "Missing",
      icnsFiles: { "default.icns": 9000, "electron.icns": 4096 },
    })
    stubPlistBuddy(bundle, "Missing")
    stubSips()
    createFromPath.mockReturnValue(renderableImage())

    await readIconDataUrl(bundle)

    expect(sipsArgs()).toContain(join(resourcesDir(bundle), "electron.icns"))
    expect(sipsArgs()).not.toContain(join(resourcesDir(bundle), "default.icns"))
  })

  it("falls back to getFileIcon when the bundle exposes no icns", async () => {
    const bundle = await createBundle("Cursor", { declaredIconFile: "Cursor" })
    stubPlistBuddy(bundle, "Cursor")
    getFileIcon.mockResolvedValue(renderableImage())

    const dataUrl = await readIconDataUrl(bundle)

    expect(dataUrl).toBe(DATA_URL)
    expect(getFileIcon).toHaveBeenCalledWith(bundle, { size: "normal" })
  })

  it("falls back to getFileIcon when PlistBuddy cannot read the plist", async () => {
    const bundle = await createBundle("Cursor")
    commandHandlers.set(PLIST_BUDDY, () => {
      throw new Error("Entry Does Not Exist")
    })
    getFileIcon.mockResolvedValue(renderableImage())

    const dataUrl = await readIconDataUrl(bundle)

    expect(dataUrl).toBe(DATA_URL)
    expect(getFileIcon).toHaveBeenCalledWith(bundle, { size: "normal" })
  })

  it("skips the bundle route for paths that are not app bundles", async () => {
    getFileIcon.mockResolvedValue(renderableImage())

    const dataUrl = await readIconDataUrl("/usr/local/bin/code")

    expect(dataUrl).toBe(DATA_URL)
    expect(execFileCalls).toHaveLength(0)
    expect(getFileIcon).toHaveBeenCalledWith("/usr/local/bin/code", { size: "normal" })
  })

  it("resizes the converted png and deletes the temporary file", async () => {
    const bundle = await createBundle("Cursor", { declaredIconFile: "Cursor" })
    stubPlistBuddy(bundle, "Cursor")
    stubSips()
    createFromPath.mockImplementation((outputPath: string) => {
      // sips 的真实产物是 PNG，这里只需占位以验证临时文件会被清理
      writeFileSync(outputPath, "")
      return renderableImage()
    })

    await readIconDataUrl(bundle)

    const args = sipsArgs()
    expect(args).toContain("-Z")
    expect(args).toContain("64")
    expect(args).toContain("--out")
    expect(existsSync(outputPathOf(args))).toBe(false)
  })

  it("falls back to the system icon when the converted png is blank", async () => {
    const bundle = await createBundle("Cursor", { declaredIconFile: "Cursor" })
    stubPlistBuddy(bundle, "Cursor")
    stubSips()
    createFromPath.mockReturnValue(blankImage())
    getFileIcon.mockResolvedValue(renderableImage())

    const dataUrl = await readIconDataUrl(bundle)

    expect(dataUrl).toBe(DATA_URL)
    expect(getFileIcon).toHaveBeenCalledWith(bundle, { size: "normal" })
  })

  it("returns null when both the bundle icon and the system icon are unusable", async () => {
    const bundle = await createBundle("Cursor", { declaredIconFile: "Cursor" })
    stubPlistBuddy(bundle, "Cursor")
    stubSips()
    createFromPath.mockReturnValue(blankImage())
    getFileIcon.mockResolvedValue(blankImage())

    expect(await readIconDataUrl(bundle)).toBeNull()
  })

  it("falls back to the system icon when sips fails", async () => {
    const bundle = await createBundle("Cursor", { declaredIconFile: "Cursor" })
    stubPlistBuddy(bundle, "Cursor")
    commandHandlers.set("sips", () => {
      throw new Error("sips exploded")
    })
    getFileIcon.mockResolvedValue(renderableImage())

    const dataUrl = await readIconDataUrl(bundle)

    expect(dataUrl).toBe(DATA_URL)
    expect(getFileIcon).toHaveBeenCalledWith(bundle, { size: "normal" })
  })
})

describe("readIconDataUrl blank image handling", () => {
  it("returns null for a fully transparent system icon", async () => {
    setPlatform("win32")
    getFileIcon.mockResolvedValue(blankImage())

    expect(await readIconDataUrl("C:\\Program Files\\Cursor\\Cursor.exe")).toBeNull()
  })

  it("returns null for a single colour system icon", async () => {
    setPlatform("win32")
    getFileIcon.mockResolvedValue(solidImage(255))

    expect(await readIconDataUrl("C:\\Program Files\\Cursor\\Cursor.exe")).toBeNull()
  })

  it("returns null for an empty system icon", async () => {
    setPlatform("win32")
    getFileIcon.mockResolvedValue({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      toBitmap: () => Buffer.alloc(0),
      toDataURL: () => DATA_URL,
    })

    expect(await readIconDataUrl("C:\\Program Files\\Cursor\\Cursor.exe")).toBeNull()
  })

  it("returns null when getFileIcon rejects", async () => {
    setPlatform("win32")
    getFileIcon.mockRejectedValue(new Error("no icon"))

    expect(await readIconDataUrl("C:\\Program Files\\Cursor\\Cursor.exe")).toBeNull()
  })
})

describe("readIconDataUrl off macOS", () => {
  it("never shells out on win32", async () => {
    setPlatform("win32")
    getFileIcon.mockResolvedValue(renderableImage())

    const dataUrl = await readIconDataUrl("C:\\Program Files\\Cursor\\Cursor.exe")

    expect(dataUrl).toBe(DATA_URL)
    expect(execFileCalls).toHaveLength(0)
  })
})

it("returns null without touching the system when there is no path", async () => {
  expect(await readIconDataUrl(null)).toBeNull()
  expect(execFileCalls).toHaveLength(0)
  expect(getFileIcon).not.toHaveBeenCalled()
})

const DATA_URL = "data:image/png;base64,rendered"

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
}

function stubPlistBuddy(bundle: string, value: string): void {
  commandHandlers.set(PLIST_BUDDY, (args) => {
    if (args[1] !== "Print :CFBundleIconFile") {
      throw new Error(`unexpected PlistBuddy command: ${args[1]}`)
    }
    return `${value}\n`
  })
}

function stubSips(): void {
  commandHandlers.set("sips", () => "")
}

function sipsArgs(): string[] {
  const call = execFileCalls.find((item) => item.file === "sips")
  if (!call) throw new Error("sips was not called")
  return call.args
}

function outputPathOf(args: string[]): string {
  const index = args.indexOf("--out")
  return args[index + 1]
}

function resourcesDir(bundle: string): string {
  return join(bundle, "Contents", "Resources")
}

function renderableImage(): unknown {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 2, height: 2 }),
    toBitmap: () => Buffer.from([0, 1, 2, 255, 3, 4, 5, 255, 6, 7, 8, 255, 9, 10, 11, 255]),
    toDataURL: () => DATA_URL,
  }
}

function blankImage(): unknown {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 4, height: 4 }),
    toBitmap: () => Buffer.alloc(4 * 4 * 4),
    toDataURL: () => DATA_URL,
  }
}

function solidImage(value: number): unknown {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 4, height: 4 }),
    toBitmap: () => Buffer.alloc(4 * 4 * 4, value),
    toDataURL: () => DATA_URL,
  }
}

async function createBundle(
  name: string,
  options: { declaredIconFile?: string; icnsFiles?: Record<string, number> } = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vykor-opener-icon-"))
  temporaryDirectories.push(root)
  const bundle = join(root, `${name}.app`)
  const resources = resourcesDir(bundle)
  await mkdir(resources, { recursive: true })
  await writeFile(join(bundle, "Contents", "Info.plist"), options.declaredIconFile ?? "")

  const icnsFiles = options.icnsFiles ?? { [`${name}.icns`]: 4096 }
  for (const [fileName, size] of Object.entries(icnsFiles)) {
    await writeFile(join(resources, fileName), Buffer.alloc(size, 1))
  }
  return bundle
}
