import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() }, shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }))
import { workspaceService } from "../workspace-service"

let root = ""
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })

it("reports missing project and external files distinctly without weakening protected paths", async () => {
  root = await mkdtemp(join(tmpdir(), "vykor-missing-file-"))
  await expect(workspaceService.readFile({ rootPath: root, path: "missing.html" })).rejects.toThrow("文件不存在")
  await expect(workspaceService.readFile({ rootPath: root, path: join(tmpdir(), `missing-${crypto.randomUUID()}.html`) })).rejects.toThrow("文件不存在")
  await expect(workspaceService.readFile({ rootPath: root, path: join(process.env.VYKOR_CONFIG_DIR!, "secret.html") })).rejects.toThrow("不支持预览")
})
