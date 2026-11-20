import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() }, shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }))
import { workspaceService } from "../workspace-service"
import { resolveWorkspaceOpenTarget } from "../workspace-path"
import { readToolImagePreview } from "../../session/read-tool-image-preview"
import type { DesktopSessionPart } from "../../../../shared/session-types"
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
it("opens historical workspace files and tool images while keeping mapped secrets and links denied", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-open-")); roots.push(root)
  const old = join(root, "old"), current = join(root, "current"), project = join(current, "workspaces/chat"), outside = join(root, "outside")
  await mkdir(project, { recursive: true }); await mkdir(outside); await mkdir(join(current, "data/migrations"), { recursive: true })
  await writeFile(join(current, "data/migrations/path-map.json"), JSON.stringify({ version: 1, moves: [{ kind: "user-root", from: old, to: current }] }))
  await writeFile(join(project, "file.txt"), "current copy"); await writeFile(join(project, "image.png"), png); await writeFile(join(current, "credentials.json"), "private")
  vi.stubEnv("VYKOR_CONFIG_DIR", current); workspaceService.configureAllowedRoots({ configDir: current, workspacesDir: join(current, "workspaces") })
  expect((await workspaceService.readFile({ rootPath: project, path: join(old, "workspaces/chat/file.txt") })).content).toBe("current copy")
  expect((await resolveWorkspaceOpenTarget(join(old, "workspaces/chat/file.txt"), project, workspaceService.allowedRootsFor(project))).path).toBe(join(project, "file.txt"))
  await expect(workspaceService.readFile({ rootPath: project, path: join(old, "credentials.json") })).rejects.toThrow()
  const part = (path: string) => ({ type: "tool", toolName: "Read", status: "completed", output: { content: [{ type: "image", source: { type: "file", path, mediaType: "image/png" } }] } } as DesktopSessionPart)
  expect(Buffer.from((await readToolImagePreview(part(join(old, "workspaces/chat/image.png")))).bytes)).toEqual(png)
  await writeFile(join(outside, "image.png"), png); await symlink(outside, join(project, "escape"), "junction")
  await expect(readToolImagePreview(part(join(old, "workspaces/chat/escape/image.png")))).rejects.toThrow()
  await expect(workspaceService.writeFile({ rootPath: project, path: `${old}-other/file.txt`, content: "bad", expectedContent: "" } as any)).rejects.toThrow()
})
