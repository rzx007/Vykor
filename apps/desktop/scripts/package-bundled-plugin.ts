import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import JSZip from "jszip"

/** Keep the official plugin a normal Native archive consumed by the existing installer. */
export async function packageKnowledgeWorkPlugin(
  sourceDirectory: string,
  outputDirectory: string
): Promise<void> {
  const zip = new JSZip()
  const date = new Date("2000-01-01T00:00:00Z")
  async function addDirectory(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = join(directory, entry.name)
      const archivePath = `${prefix}${entry.name}`
      if (entry.isDirectory()) await addDirectory(filePath, `${archivePath}/`)
      else if (entry.isFile()) {
        zip.file(archivePath, await readFile(filePath), { date, createFolders: false })
      }
      else throw new Error(`Bundled plugin contains an unsupported file: ${filePath}`)
    }
  }
  await addDirectory(sourceDirectory)
  await mkdir(outputDirectory, { recursive: true })
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" })
  await writeFile(join(outputDirectory, "knowledge-work.zip"), archive)
}
