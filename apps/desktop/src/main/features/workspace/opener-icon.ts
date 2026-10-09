import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import { app, nativeImage, type NativeImage } from "electron"

const PLIST_BUDDY = "/usr/libexec/PlistBuddy"
const ICON_SIZE = "64"
const COMMAND_TIMEOUT = 5000

export async function readIconDataUrl(path: string | null): Promise<string | null> {
  if (!path) return null
  if (process.platform === "darwin") {
    const bundleIcon = await readBundleIconDataUrl(path)
    if (bundleIcon) return bundleIcon
  }
  return readSystemIconDataUrl(path)
}

/**
 * macOS 上 `app.getFileIcon` 对 `.app` 包会返回通用/空白位图（electron#15809、#36101），
 * 所以改成从包内读 CFBundleIconFile 指向的 .icns，再用系统 sips 转成 PNG。
 */
async function readBundleIconDataUrl(bundlePath: string): Promise<string | null> {
  if (!bundlePath.endsWith(".app")) return null
  const icnsPath = await resolveBundleIcnsPath(bundlePath)
  if (!icnsPath) return null
  return convertIcnsToDataUrl(icnsPath)
}

async function resolveBundleIcnsPath(bundlePath: string): Promise<string | null> {
  const resourcesDir = join(bundlePath, "Contents", "Resources")
  const declaredName = await readDeclaredIconFileName(bundlePath)
  if (declaredName) {
    // GitHub Desktop 这类 Electron 应用直接写 `electron.icns`；
    // Finder / Terminal / Xcode 的 plist 值不带后缀，得补 `.icns`。
    const declared = join(resourcesDir, declaredName)
    if (await isReadableFile(declared)) return declared
    if (await isReadableFile(`${declared}.icns`)) return `${declared}.icns`
  }
  const candidates = await listIcnsCandidates(resourcesDir)
  return candidates[0] ?? null
}

async function readDeclaredIconFileName(bundlePath: string): Promise<string | null> {
  try {
    const stdout = await runCommand(PLIST_BUDDY, [
      "-c",
      "Print :CFBundleIconFile",
      join(bundlePath, "Contents", "Info.plist"),
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function listIcnsCandidates(resourcesDir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(resourcesDir, { withFileTypes: true })
  } catch {
    return []
  }

  const icnsNames = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        extname(entry.name).toLowerCase() === ".icns" &&
        entry.name.toLowerCase() !== "default.icns"
    )
    .map((entry) => join(resourcesDir, entry.name))

  const sized = await Promise.all(
    icnsNames.map(async (path) => ({ path, size: await fileSize(path) }))
  )
  return sized.sort((left, right) => right.size - left.size).map((item) => item.path)
}

async function convertIcnsToDataUrl(icnsPath: string): Promise<string | null> {
  const outputPath = join(tmpdir(), `vykor-opener-icon-${randomUUID()}.png`)
  try {
    await runCommand("sips", [
      "-s",
      "format",
      "png",
      "-Z",
      ICON_SIZE,
      icnsPath,
      "--out",
      outputPath,
    ])
    return toDataUrlIfRenderable(nativeImage.createFromPath(outputPath))
  } catch {
    return null
  } finally {
    await rm(outputPath, { force: true }).catch(() => undefined)
  }
}

async function readSystemIconDataUrl(path: string): Promise<string | null> {
  try {
    const image = await app.getFileIcon(path, { size: "normal" })
    return toDataUrlIfRenderable(image)
  } catch {
    return null
  }
}

function toDataUrlIfRenderable(image: NativeImage): string | null {
  if (isBlankImage(image)) return null
  return image.toDataURL()
}

/**
 * `isEmpty()` 只认「完全空的图」。macOS 经常返回「有尺寸但整张全透明或纯色」的位图，
 * 那种图照样是 truthy，会一路塞进 <img> 变成一个空白方块。这里把这类也判为不可用，
 * 让渲染层回退到 lucide 兜底图标。
 */
function isBlankImage(image: NativeImage): boolean {
  if (image.isEmpty()) return true

  const size = image.getSize()
  if (size.width <= 0 || size.height <= 0) return true

  const bitmap = image.toBitmap()
  if (bitmap.length !== size.width * size.height * 4) return true

  const first = bitmap[0]
  for (let index = 1; index < bitmap.length; index += 1) {
    if (bitmap[index] !== first) return false
  }
  return true
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}
