import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "@vykor/host-config";
import { installLocalNativePlugin } from "@vykor/plugins";
import { expect, it, vi } from "vitest";
import * as discovery from "../plugin-discovery.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

it("shares discovery reads while applying each caller's plugin and MCP settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "vykor-shared-extensions-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("VYKOR_DATA_DIR", join(root, "data"));
  try {
    const cwd = join(root, "workspace");
    const projectSkills = join(cwd, ".vykor", "skills");
    const projectSkill = join(projectSkills, "draft-note.md");
    await mkdir(projectSkills, { recursive: true });
    await writeFile(projectSkill, "---\nname: draft-note\ndescription: Project note\n---\nWrite a note.\n");

    const sourcePath = join(root, "plugin");
    const manifestDir = join(sourcePath, ".vykor-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, "plugin.json"), JSON.stringify({
      schemaVersion: 1, id: "dev.discovery.notes", name: "notes", version: "1.0.0",
      components: { skills: ["./commit.md", "./draft-note.md"], mcpServers: ["./mcp.json"] },
    }));
    await writeFile(join(sourcePath, "commit.md"), "Plugin commit instructions");
    await writeFile(join(sourcePath, "draft-note.md"), "Plugin note instructions");
    await writeFile(join(sourcePath, "mcp.json"), JSON.stringify({ servers: { notes: { type: "stdio", command: "notes-plugin" } } }));
    await writeFile(join(sourcePath, "LICENSE"), "Fixture license");
    const installed = await installLocalNativePlugin({ sourcePath, cwd, scope: "user", approvedPermissions: [] });
    if (installed.status !== "installed") throw new Error(JSON.stringify(installed.diagnostics));
    const digestOnlyFile = join(installed.record.cachePath, "LICENSE");

    const { discoverVykorExtensions, withSharedExtensionDiscovery } = discovery;
    const settings = await loadSettings({});
    let resume!: () => void;
    const afterScope = new Promise<void>((resolve) => { resume = resolve; });
    vi.mocked(readFile).mockClear();
    const later = await withSharedExtensionDiscovery(async () => {
      const disabled = await discoverVykorExtensions(cwd, settings, { pluginsEnabled: false });
      expect(disabled.plugins).toEqual([]);
      expect(disabled.skillRegistry.get("commit")?.source).toBe("bundled");
      expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === digestOnlyFile)).toHaveLength(0);

      const enabled = await discoverVykorExtensions(cwd, settings);
      expect(enabled.plugins.map((plugin) => plugin.manifest.id)).toEqual(["dev.discovery.notes"]);
      expect(enabled.skillRegistry.get("commit")?.source).toBe("plugin");
      expect(enabled.skillRegistry.getNonPluginSkills().find((skill) => skill.name === "commit")?.source).toBe("bundled");
      expect(enabled.skillRegistry.get("draft-note")?.source).toBe("project");
      expect(enabled.skillRegistry.resolve("notes:draft-note")?.source).toBe("plugin");
      expect(enabled.mcpServers.notes).toMatchObject({ command: "notes-plugin" });

      const conflict = await discoverVykorExtensions(cwd, {
        ...settings, mcpServers: { notes: { type: "stdio", command: "host-notes" } },
      });
      expect(conflict.plugins).toEqual([]);
      expect(conflict.skillRegistry.resolve("notes:draft-note")).toBeUndefined();
      expect(conflict.mcpServers.notes).toMatchObject({ command: "host-notes" });
      expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === projectSkill)).toHaveLength(1);
      expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === digestOnlyFile)).toHaveLength(1);

      return { discovery: afterScope.then(() => discoverVykorExtensions(cwd, settings)) };
    });

    await writeFile(digestOnlyFile, "Changed after verification");
    await writeFile(projectSkill, "---\nname: draft-note\ndescription: Updated note\n---\nWrite a new note.\n");
    resume();
    const fresh = await later.discovery;
    expect(fresh.plugins).toEqual([]);
    expect(fresh.skillRegistry.get("draft-note")?.description).toBe("Updated note");
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
