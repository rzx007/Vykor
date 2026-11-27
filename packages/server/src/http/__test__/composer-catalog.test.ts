import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installLocalNativePlugin } from "@vykor/plugins";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";
import { expect, it, vi } from "vitest";
import { startVykorDaemon } from "../../daemon/default-daemon.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

it("builds both composer catalogs from one verified discovery and checks current files on the next read", async () => {
  const root = await mkdtemp(join(tmpdir(), "vykor-composer-catalog-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("VYKOR_DATA_DIR", join(root, "data"));
  let daemon: Awaited<ReturnType<typeof startVykorDaemon>> | undefined;
  try {
    const cwd = join(root, "project");
    const projectSkills = join(cwd, ".vykor", "skills");
    const projectSkill = join(projectSkills, "draft-note.md");
    await mkdir(projectSkills, { recursive: true });
    await writeFile(projectSkill, "---\nname: draft-note\ndescription: Draft a note\n---\nWrite a note.\n");

    const sourcePath = join(root, "plugin");
    const manifestDir = join(sourcePath, ".vykor-plugin");
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, "plugin.json"), JSON.stringify({
      schemaVersion: 1, id: "dev.composer.notes", name: "notes", displayName: "Notes", version: "1.0.0",
      components: { skills: ["./outline.md"] },
    }));
    await writeFile(join(sourcePath, "outline.md"), "---\nname: outline\ndescription: Outline a note\n---\nWrite an outline.\n");
    await writeFile(join(sourcePath, "LICENSE"), "Fixture license");
    const installed = await installLocalNativePlugin({ sourcePath, cwd, scope: "user", approvedPermissions: [] });
    if (installed.status !== "installed") throw new Error(JSON.stringify(installed.diagnostics));
    const digestOnlyFile = join(installed.record.cachePath, "LICENSE");

    const token = "composer-catalog-fixture";
    daemon = await startVykorDaemon({ host: "127.0.0.1", port: 0, token,
      storePath: join(root, "sessions.db"), deferBackgroundActivation: true, logger: () => {} });
    const { url } = daemon.listen;
    const get = (pathname: string, workingDirectory?: string, sessionId?: string) => {
      const endpoint = new URL(pathname, url);
      if (workingDirectory !== undefined) endpoint.searchParams.set("cwd", workingDirectory);
      if (sessionId !== undefined) endpoint.searchParams.set("sessionId", sessionId);
      return fetch(endpoint, { headers: {
        authorization: `Bearer ${token}`,
        [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION),
      } });
    };

    expect((await get("/context/composer-catalog")).status).toBe(400);
    vi.mocked(readFile).mockClear();
    const response = await get("/context/composer-catalog", cwd);
    expect(response.status).toBe(200);
    const catalog = await response.json();
    expect(catalog).not.toHaveProperty("contextUsage");
    expect(catalog.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "/status", kind: "session" }),
      expect.objectContaining({ name: "/draft-note", kind: "template", source: "project", path: projectSkill }),
      expect.objectContaining({ name: "/notes:outline", kind: "template", source: "plugin" }),
    ]));
    expect(catalog.plugins).toEqual([{
      pluginId: "dev.composer.notes", displayName: "Notes", description: "", version: "1.0.0",
      scope: "user", origin: "native", capabilities: ["skills"],
    }]);
    expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === projectSkill)).toHaveLength(1);
    expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === digestOnlyFile)).toHaveLength(1);

    expect(await (await get("/commands", cwd)).json()).toEqual({ commands: catalog.commands });
    expect(await (await get("/context/plugins", cwd)).json()).toEqual({ plugins: catalog.plugins });

    const model = "claude-sonnet-4-6";
    const session = daemon.server.store.sessions.create({ cwd, model, title: "Cold chat", metadata: { runtime: { model } } });
    vi.mocked(readFile).mockClear();
    expect((await get(`/sessions/${encodeURIComponent(session.id)}/state?partView=summary`)).status).toBe(200);
    const pairedResponse = await get("/context/composer-catalog", cwd, session.id);
    expect(pairedResponse.status).toBe(200);
    const paired = await pairedResponse.json();
    expect(paired).toMatchObject({ ...catalog, contextUsage: { source: "live_assembly", model } });
    expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === projectSkill)).toHaveLength(1);
    expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === digestOnlyFile)).toHaveLength(1);

    await writeFile(digestOnlyFile, "Changed after installation");
    const changed = await (await get("/context/composer-catalog", cwd)).json();
    expect(changed.plugins).toEqual([]);
    expect(changed.commands).not.toContainEqual(expect.objectContaining({ name: "/notes:outline" }));
    expect(changed.commands).toContainEqual(expect.objectContaining({ name: "/draft-note" }));
  } finally {
    await daemon?.server.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
