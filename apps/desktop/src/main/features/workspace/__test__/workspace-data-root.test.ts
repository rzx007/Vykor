import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { initializeDataRoot } from "@vykor/host-config/paths";
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() }, shell: { openPath: vi.fn(), showItemInFolder: vi.fn() } }));
import { workspaceService } from "../workspace-service";

it("uses the fixed data root for personal file access and preserves explicitly supplied roots", async () => {
  const base = await mkdtemp(join(tmpdir(), "vykor-workspace-root-"));
  const root = join(base, "selected"), home = join(base, "home"), project = join(base, "project");
  await mkdir(home); await mkdir(root); await mkdir(project);
  try {
    await initializeDataRoot({ explicitRoot: root, homeDir: home, env: {} });
    vi.stubEnv("VYKOR_CONFIG_DIR", join(base, "late-env"));
    await writeFile(join(root, "USER.md"), "Selected profile");
    await writeFile(join(root, "private.txt"), "Private product data");
    await expect(workspaceService.readFile({ rootPath: project, path: join(root, "private.txt") })).rejects.toThrow("不支持预览");
    expect((await workspaceService.readFile({ rootPath: project, path: join(root, "USER.md") })).content).toBe("Selected profile");
    const explicit = join(base, "embedded"); await mkdir(explicit); await writeFile(join(explicit, "USER.md"), "Embedded profile");
    workspaceService.configureAllowedRoots({ configDir: explicit, workspacesDir: "" });
    expect((await workspaceService.readFile({ rootPath: project, path: join(explicit, "USER.md") })).content).toBe("Embedded profile");
  } finally { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); }
});
