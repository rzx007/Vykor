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

it("installs author dependencies, builds outside the repository and runs the actual preview tool", async () => {
  const root = await workspace();
  const plugin = join(root, "text-inspector");
  await cp(join(distribution, "assets", "text-inspector"), plugin, { recursive: true });
  const installed = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: plugin, encoding: "utf8", shell: process.platform === "win32" });
  expect(installed.status, installed.stderr).toBe(0);
  const built = spawnSync(process.execPath, [join(plugin, "scripts", "build-ui.mjs")], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
  const html = await readFile(join(plugin, "ui", "panel.html"), "utf8");
  expect(spawnSync(process.execPath, ["--check", join(plugin, "ui", "panel.mjs")]).status).toBe(0);
  expect(Buffer.byteLength(html)).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(html).not.toMatch(/<(?:script|link|iframe)\b[^>]*(?:src|href)=/i);
  const manifest = JSON.parse(await readFile(join(plugin, "ui", "apps.json"), "utf8"));
  expect(manifest).toMatchObject({ schemaVersion: 1, backends: [{ kind: "native-tools" }], surfaces: [{ availability: "session" }] });
  expect(JSON.stringify(manifest)).not.toContain("inputSchema");
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
  expect(result.metadata.appData.text).toBe("ok\n\titem\n");
  expect(checked.metadata.appData.findings).toHaveLength(2);
  expect(result.metadata.ui).toBeUndefined();
  expect(check.invoke({ text: "x".repeat(47998) }).metadata.appData).toBeDefined();
  expect(check.invoke({ text: "x".repeat(47999) }).metadata).toBeUndefined();
}, 120_000);

it("ships identical official App sources and offline pages in both distributions", async () => {
  const example = fileURLToPath(new URL("../../../examples/plugins/text-inspector/", import.meta.url));
  for (const file of ["ui/panel.mjs", "ui/panel.html", "ui/styles.css", "ui/apps.json", "scripts/build-ui.mjs", "package.json", "package-lock.json", "tools/index.mjs"])
    expect(await readFile(join(distribution, "assets/text-inspector", file), "utf8")).toBe(await readFile(join(example, file), "utf8"));
  const asset = join(distribution, "assets/text-inspector");
  const metadata = JSON.parse(await readFile(join(asset, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(asset, "package-lock.json"), "utf8"));
  const definition = JSON.parse(await readFile(join(asset, ".vykor-plugin/plugin.json"), "utf8"));
  expect(lock.version).toBe(metadata.version);
  expect(lock.packages[""].version).toBe(metadata.version);
  expect(definition.version).toBe(metadata.version);
  const panel = await readFile(join(example, "ui/panel.mjs"), "utf8");
  expect(panel).toContain('from "@modelcontextprotocol/ext-apps"');
  expect(panel).not.toMatch(/VykorPluginUi|requestAction|requestConversation/);
  await expect(readFile(join(example, "ui/sdk.js"))).rejects.toThrow();
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
