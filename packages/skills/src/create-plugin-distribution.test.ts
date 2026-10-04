import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { createSkillRegistrySnapshot } from "./index.js";

const distribution = fileURLToPath(new URL("../../../skills/create-plugin/", import.meta.url));
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "vykor-plugin-skill-"));
  temporary.push(path);
  return path;
}

it("does not expose plugin authoring to the model or slash lookup without an installed skill", async () => {
  const registry = await createSkillRegistrySnapshot();
  expect(registry.resolve("create-plugin")).toBeUndefined();
  expect(registry.modelVisibleList().some(skill => skill.name === "create-plugin")).toBe(false);
});

it("loads a separately copied distribution as one user skill, not a bundled skill", async () => {
  const root = await workspace();
  const skill = join(root, "skills", "create-plugin");
  await cp(distribution, skill, { recursive: true });
  const registry = await createSkillRegistrySnapshot({ userDir: join(root, "skills") });
  expect(registry.resolve("create-plugin")).toMatchObject({
    source: "user", path: join(skill, "SKILL.md"), userInvocable: true,
  });
  // Examples/references shipped with the skill must not become additional skills.
  expect(registry.getAll().filter(skill => skill.source === "user").map(skill => skill.name))
    .toEqual(["create-plugin"]);
});

it("builds the copied UI example with Node alone and runs its actual preview tool", async () => {
  const root = await workspace();
  const plugin = join(root, "text-inspector");
  await cp(join(distribution, "assets", "text-inspector"), plugin, { recursive: true });
  const built = spawnSync(process.execPath, [join(plugin, "scripts", "build-ui.mjs")], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  const html = await readFile(join(plugin, "ui", "panel.html"), "utf8");
  expect(spawnSync(process.execPath, ["--check", join(plugin, "ui", "panel.mjs")]).status).toBe(0);
  expect(Buffer.byteLength(html)).toBeLessThanOrEqual(2 * 1024 * 1024);
  const { registerTools } = await import(/* @vite-ignore */ pathToFileURL(join(plugin, "tools", "index.mjs")).href);
  const tools = registerTools();
  const check = tools.find(tool => tool.name === "TextInspectorCheck");
  const preview = tools.find(tool => tool.name === "TextInspectorPreview");
  const checked = check.invoke({ text: "ok  \n\titem\n" });
  expect(JSON.parse(checked.content[0].text)).toEqual({ findings: [
    { line: 1, code: "trailing-whitespace" }, { line: 2, code: "tab-indentation" },
  ], truncated: false });
  const result = preview.invoke({ text: "ok  \n\titem\n", selected: ["1:trailing-whitespace"] });
  expect(JSON.parse(result.content[0].text).text).toBe("ok\n\titem\n");
  expect(result.metadata.ui.componentId).toBe("text-inspector");
});

it.each([
  ["TextInspectorCheck", "oversized"], ["TextInspectorPreview", "oversized"],
  ["TextInspectorCheck", "cancelled"], ["TextInspectorPreview", "cancelled"],
] as const)(
  "example tool %s rejects %s direct calls", async (name, reason) => {
    const entry = join(distribution, "assets", "text-inspector", "tools", "index.mjs");
    const { registerTools } = await import(/* @vite-ignore */ pathToFileURL(entry).href);
    const tool = registerTools().find(tool => tool.name === name);
    const args = { text: "ok  \n", ...(name.endsWith("Preview") ? { selected: ["1:trailing-whitespace"] } : {}) };
    const abort = new AbortController();
    const context = { plugin: { id: "example.text-inspector", name: "text-inspector", version: "1.1.1", root: join(distribution, "assets", "text-inspector") },
      permissions: [], cwd: distribution, deadline: Date.now() + 1000, signal: abort.signal };
    if (reason === "oversized") args.text = "x".repeat(100001) + " \n";
    else abort.abort();
    expect(() => tool.invoke(args, context)).toThrow();
  }
);
