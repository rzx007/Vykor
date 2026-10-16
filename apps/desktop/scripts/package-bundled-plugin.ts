import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import JSZip from "jszip"

/** Keep the official plugin a normal Native archive consumed by the existing installer. */
export async function packageKnowledgeWorkPlugin(
  sourceDirectory: string,
  outputDirectory: string
): Promise<void> {
  await packageNativePlugin(sourceDirectory, outputDirectory, "knowledge-work.zip")
}

export async function packageOfficeWorkPlugin(
  sourceDirectory: string,
  outputDirectory: string,
  engineBinaryPath: string,
  engineModulePath: string
): Promise<void> {
  const asset = basename(engineBinaryPath)
  if (!["officecli-win-x64.exe", "officecli-mac-arm64", "officecli-linux-x64"].includes(asset)) throw new Error(`Unsupported bundled Office engine: ${asset}`)
  await packageNativePlugin(sourceDirectory, outputDirectory, "office-work.zip", {
    [`bin/${asset}`]: engineBinaryPath,
    "tools/office-engine.mjs": engineModulePath,
  })
}

async function packageNativePlugin(
  sourceDirectory: string,
  outputDirectory: string,
  archiveName: string,
  preparedFiles: Record<string, string> = {}
): Promise<void> {
  const zip = new JSZip()
  const date = new Date("2000-01-01T00:00:00Z")
  async function addDirectory(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!prefix && ["test", "scripts", "out", "bin", ".gitignore"].includes(entry.name)) continue
      const filePath = join(directory, entry.name)
      const archivePath = `${prefix}${entry.name}`
      if (archivePath in preparedFiles) continue
      if (entry.isDirectory()) await addDirectory(filePath, `${archivePath}/`)
      else if (entry.isFile()) {
        zip.file(archivePath, await readFile(filePath), { date, createFolders: false })
      } else throw new Error(`Bundled plugin contains an unsupported file: ${filePath}`)
    }
  }
  await addDirectory(sourceDirectory)
  for (const [archivePath, sourcePath] of Object.entries(preparedFiles)) {
    zip.file(archivePath, await readFile(sourcePath), { date, createFolders: false, unixPermissions: archivePath.startsWith("bin/") ? 0o100755 : 0o100644 })
  }
  await mkdir(outputDirectory, { recursive: true })
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "STORE", platform: "UNIX" })
  await writeFile(join(outputDirectory, archiveName), archive)
}
