import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { initializeDataRoot, getSkillsDir, getProjectMemoryDir, readDataRootLockState } from "@vykor/host-config/paths";
import { CredentialStorage } from "@vykor/auth";
import { saveFacts, loadFacts, loadLocalRules, saveLocalRules } from "@vykor/personalization";
import { initializePersonalPromptFiles, loadSoulMd, loadUserProfile, queueUserProfileUpdate, listPendingUserProfileUpdates } from "@vykor/prompts";
import { createSkillRegistrySnapshot, findProjectSkillDirs } from "@vykor/skills";
import { loadNodeAgentDefinitions } from "@vykor/agent-runtime";
import { ModelCatalogService } from "@vykor/api";
import { MemoryManager } from "@vykor/memory";
import { loadRuntimeSecrets, saveRuntimeSecrets } from "../runtime/runtime-secrets.js";

async function snapshot(root: string, current = root): Promise<string[]> {
  const items: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = join(current, entry.name);
    items.push(entry.isDirectory() ? `${relative(root, file)}/` : `${relative(root, file)}:${createHash("sha256").update(await readFile(file)).digest("hex")}`);
    if (entry.isDirectory()) items.push(...await snapshot(root, file));
  }
  return items.sort();
}

it("persists and reopens all user business files in the initialized root, leaving old home business files untouched", async () => {
  const base = await mkdtemp(join(tmpdir(), "vykor-user-data-"));
  const home = join(base, "home"), old = join(home, ".vykor"), root = join(base, ".vykor");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, "USER.md"), "old profile");
  await writeFile(join(old, "SOUL.md"), "old soul");
  await writeFile(join(old, "credentials.json"), '{"test":{"api_key":"old"}}');
  const before = await snapshot(home);
  try {
    await initializeDataRoot({ explicitRoot: root, homeDir: home, env: {} });
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("VYKOR_CONFIG_DIR", join(base, "late-env")); vi.stubEnv("VYKOR_DATA_DIR", undefined);
    vi.stubEnv("VYKOR_MODELS_PATH", undefined); vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", undefined);
    const cwd = join(base, "project");
    const fact = { key: "conda_env:target-env", type: "conda_env", label: "Conda environment", value: "target-env", confidence: 0.9, sourceSessionId: "session", sourceMessageId: "message", observedAt: "2026-11-12T00:00:00.000Z" };
    saveFacts({ facts: [fact] }, cwd); const rulePath = saveLocalRules("selected rule", cwd);
    expect(await readFile(rulePath, "utf8")).toBe("selected rule\n");
    expect(loadFacts(cwd).facts[0]?.value).toBe("target-env"); expect(loadLocalRules(cwd)).toContain("target-env");
    expect(rulePath.startsWith(join(root, "local_rules", "projects"))).toBe(true);
    await initializePersonalPromptFiles();
    const update = await queueUserProfileUpdate({ content: "Prefer concise answers.", source: "test" });
    expect(await listPendingUserProfileUpdates()).toContainEqual(update);
    expect(JSON.parse(await readFile(join(root, "user_profile_pending", `${update.id}.json`), "utf8")).content).toBe("Prefer concise answers.");
    expect(await loadSoulMd()).toContain("careful local coding agent"); expect(await loadUserProfile()).toContain("Communication preferences");
    await saveRuntimeSecrets("test", { TEMP_SECRET: "temporary-value" });
    expect(await loadRuntimeSecrets("test", ["TEMP_SECRET"])).toEqual({ TEMP_SECRET: "temporary-value" });
    expect(JSON.parse(await readFile(join(root, "runtime-environment-secrets.json"), "utf8")).test.TEMP_SECRET).toBe("temporary-value");
    const store = new CredentialStorage(); await store.storeApiKey("test", "new"); await store.close();
    const reopened = new CredentialStorage(); expect(await reopened.loadApiKey("test")).toBe("new"); await reopened.close();
    await mkdir(join(root, "agents")); await writeFile(join(root, "agents", "target-agent.md"), "---\nmodel: target-model\n---\nSelected agent.");
    expect(loadNodeAgentDefinitions().find(agent => agent.name === "target-agent")?.model).toBe("target-model");
    await mkdir(join(root, "skills")); await writeFile(join(root, "skills", "target-skill.md"), "---\nname: target-skill\ndescription: Selected skill\n---\nSelected content.");
    const registry = await createSkillRegistrySnapshot({ bundled: false, userDir: getSkillsDir() });
    expect(registry.get("target-skill")?.content).toContain("Selected content.");
    expect(await findProjectSkillDirs(base)).not.toContain(join(root, "skills"));
    const memory = new MemoryManager(10, getProjectMemoryDir(cwd));
    const saved = await memory.add("target memory");
    expect((await new MemoryManager(10, getProjectMemoryDir(cwd)).getAll()).some(entry => entry.id === saved.id)).toBe(true);
    vi.stubGlobal("fetch", async () => Response.json({ target: { models: { selected: { name: "Selected model" } } } }));
    expect((await new ModelCatalogService().load()).target?.models?.selected?.name).toBe("Selected model");
    expect(JSON.parse(await readFile(join(root, "cache", "models-dev.json"), "utf8")).target.models.selected.name).toBe("Selected model");
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    expect((await new ModelCatalogService().load()).target?.models?.selected?.name).toBe("Selected model");
    expect(await snapshot(home)).toEqual([...before, ".vykor-root.json.lock/"].sort());
    expect(readDataRootLockState(home)).toBeUndefined();
    expect(await readdir(base)).not.toContain("late-env");
  } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
