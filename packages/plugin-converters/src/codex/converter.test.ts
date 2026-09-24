import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadNativePlugin, requestedPluginPermissions, validateNativePlugin } from "@vykor/plugins";
import { createBuiltinConverterRegistry, type ConversionPlan } from "../index.js";

const fixture = fileURLToPath(new URL("../../fixtures/codex/mixed-plugin/", import.meta.url));
const temporary: string[] = [];
const portableSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "vk-codex-test-")); temporary.push(root);
  const source = join(root, "source"); await cp(fixture, source, { recursive: true });
  return { root, source, output: join(root, "native") };
}
async function json(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value));
}
async function prepare(source: string) {
  const { converter } = await createBuiltinConverterRegistry().detect(source, "codex");
  const inspection = await converter.inspect(source);
  const plan = await converter.plan(inspection);
  return { converter, inspection, plan };
}
const approvals = (plan: ConversionPlan) => plan.items.flatMap(item => item.requiredApprovals ?? []);

describe("Codex conversion", () => {
  it("detects explicit Codex evidence over Claude directory heuristics and reports true ambiguity", async () => {
    const { source } = await setup();
    const registry = createBuiltinConverterRegistry();
    expect((await registry.detect(source)).converter.id).toBe("codex");
    await json(join(source, ".claude-plugin/plugin.json"), { name: "review-helper" });
    await expect(registry.detect(source)).rejects.toThrow(/ambiguous/i);
    expect((await registry.detect(source, "codex")).converter.id).toBe("codex");
  });

  it("requires loss approval and produces loadable Native skills and MCP without running scripts", async () => {
    const { source, output, root } = await setup();
    const { converter, inspection, plan } = await prepare(source);
    expect(inspection.identity).toEqual({ id: "converted.codex.review-helper", name: "review-helper", version: "1.2.3" });
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKind: "skills", fidelity: "exact" }),
      expect.objectContaining({ sourceKind: "mcpServers", fidelity: "adapted" }),
      expect.objectContaining({ sourceKind: "apps", fidelity: "unsupported" }),
    ]));
    await expect(converter.convert({ inspection, plan, output })).rejects.toThrow(/approval/i);
    expect((await readdir(root)).sort()).toEqual(["source"]);
    const report = await converter.convert({ inspection, plan, output, approvals: approvals(plan) });
    expect(report.status).toBe("partial");
    const validation = await validateNativePlugin(output);
    expect(validation.status).toBe("valid");
    expect(validation.plugin!.manifest).toMatchObject({ displayName: "Review Helper", metadata: { origin: "converted", sourceFormat: "codex" } });
    expect(requestedPluginPermissions(validation.plugin!.manifest)).toEqual(["network:https://docs.example.invalid"]);
    const loaded = await loadNativePlugin(validation.plugin!);
    expect(loaded.status).toBe("loaded");
    expect(loaded.components.skills?.value?.map(skill => skill.name)).toEqual(["review"]);
    expect(loaded.components.mcpServers?.value).toEqual({ docs: { type: "http", url: "https://docs.example.invalid/mcp" } });
    expect(await readFile(join(output, "skills/review/references/checklist.md"), "utf8")).toContain("permissions");
    await expect(access(join(output, ".codex-plugin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(output, ".app.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(output, ".vykor-conversion/report.json"), "utf8"))).toEqual(report);
  });

  it("uses portable identity and fixed components, replacing the entire legacy overlay with an inline extension", async () => {
    const { source, output } = await setup();
    await json(join(source, "plugin.json"), { $schema: portableSchema, name: "portable-review", extensions: { "com.openai": { interface: { displayName: "Portable Review" }, skills: "./missing", mcpServers: "./missing.json" } } });
    await json(join(source, "mcp.json"), { mcpServers: { docs: { type: "streamable-http", url: "https://portable.example.invalid/mcp" } } });
    const { converter, inspection, plan } = await prepare(source);
    expect(inspection.identity).toEqual({ id: "converted.codex.portable-review", name: "portable-review", version: "0.0.0" });
    expect(plan.items.some(item => item.sourceKind === "apps")).toBe(false);
    await converter.convert({ inspection, plan, output, approvals: approvals(plan) });
    const validation = await validateNativePlugin(output);
    const loaded = await loadNativePlugin(validation.plugin!);
    expect(loaded.components.mcpServers?.value).toEqual({ docs: { type: "http", url: "https://portable.example.invalid/mcp" } });
    expect(validation.plugin!.manifest.displayName).toBe("Portable Review");
  });

  it("preserves custom skill paths and their shared resource references", async () => {
    const { source, output } = await setup();
    await cp(join(source, "skills/review"), join(source, "guides/review"), { recursive: true });
    await mkdir(join(source, "assets")); await writeFile(join(source, "assets/shared.txt"), "shared resource");
    await json(join(source, ".codex-plugin/plugin.json"), { name: "custom", skills: "./guides" });
    const { converter, inspection, plan } = await prepare(source);
    await converter.convert({ inspection, plan, output, approvals: approvals(plan) });
    const validation = await validateNativePlugin(output);
    expect(validation.plugin!.manifest.components.skills).toEqual(["./guides/review/SKILL.md"]);
    expect(await readFile(join(output, "assets/shared.txt"), "utf8")).toBe("shared resource");
    expect((await loadNativePlugin(validation.plugin!)).components.skills?.value).toHaveLength(1);
  });

  it.each([
    { skills: "../outside" }, { skills: "./../outside" }, { skills: "C:/outside" },
    { skills: ["./skills", 42] }, { mcpServers: "./missing.json" },
  ])("rejects malformed or escaping component declarations %j", async declaration => {
    const { source } = await setup();
    await json(join(source, ".codex-plugin/plugin.json"), { name: "invalid", ...declaration });
    await expect(prepare(source)).rejects.toThrow(/component path|must be a path/i);
  });

  it("rejects source symlinks including a linked manifest directory before reading source contents", async () => {
    const { root, source } = await setup();
    const external = join(root, "outside"); await mkdir(external);
    await symlink(external, join(source, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(prepare(source)).rejects.toThrow(/link/i);
  });

  it("rejects source changes and modified plans without creating output", async () => {
    const { source, output, root } = await setup();
    const { converter, inspection, plan } = await prepare(source);
    await expect(converter.convert({ inspection, plan: { ...plan, items: [] }, output })).rejects.toThrow(/plan/i);
    await writeFile(join(source, "skills/review/references/checklist.md"), "changed");
    await expect(converter.convert({ inspection, plan, output, approvals: approvals(plan) })).rejects.toThrow(/source changed/i);
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("rejects nested or existing output and preserves existing files", async () => {
    const { source, output } = await setup();
    const { converter, inspection, plan } = await prepare(source);
    const input = { inspection, plan, approvals: approvals(plan) };
    await expect(converter.convert({ ...input, output: join(source, "native") })).rejects.toThrow(/source|inside/i);
    await mkdir(output); await writeFile(join(output, "keep.txt"), "keep");
    await expect(converter.convert({ ...input, output })).rejects.toThrow(/exists/i);
    expect(await readFile(join(output, "keep.txt"), "utf8")).toBe("keep");
  });

  it("reports unsupported MCP semantics instead of removing fields or inventing local runtime bindings", async () => {
    const { source, output } = await setup();
    await json(join(source, ".mcp.json"), { mcpServers: {
      local: { command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] },
      authenticated: { url: "https://example.invalid/mcp", oauth: { clientId: "public-id" } },
      unknown: { url: "https://example.invalid/mcp", enabled_tools: ["read"] },
    } });
    const { converter, inspection, plan } = await prepare(source);
    expect(plan.items.filter(item => item.sourceKind === "mcpServers")).toHaveLength(3);
    expect(plan.items.filter(item => item.sourceKind === "mcpServers").every(item => item.fidelity === "unsupported")).toBe(true);
    await converter.convert({ inspection, plan, output, approvals: approvals(plan) });
    expect((await validateNativePlugin(output)).plugin!.manifest.components.mcpServers).toBeUndefined();
  });

  it("requires explicit approval for Codex skill invocation policy that Native does not consume", async () => {
    const { source, output } = await setup();
    await mkdir(join(source, "skills/review/agents"));
    await writeFile(join(source, "skills/review/agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    const { converter, inspection, plan } = await prepare(source);
    expect(plan.items).toContainEqual(expect.objectContaining({ sourcePath: "skills/review/agents/openai.yaml", fidelity: "unsupported" }));
    await expect(converter.convert({ inspection, plan, output, approvals: approvals(plan).filter(item => !item.includes("openai.yaml")) })).rejects.toThrow(/approval/i);
  });

  it("does not parse an unused legacy overlay when portable inline settings replace it", async () => {
    const { source } = await setup();
    await json(join(source, "plugin.json"), { $schema: portableSchema, name: "portable-review", extensions: { "com.openai": {} } });
    await writeFile(join(source, ".codex-plugin/plugin.json"), "not JSON");
    const { plan } = await prepare(source);
    expect(plan.items.map(item => item.sourceKind)).toEqual(["skills"]);
  });

  it("loads an overlapping skill declaration only once", async () => {
    const { source, output } = await setup();
    await json(join(source, ".codex-plugin/plugin.json"), { name: "overlap", skills: ["./skills", "./skills/review"] });
    const { converter, inspection, plan } = await prepare(source);
    await converter.convert({ inspection, plan, output, approvals: approvals(plan) });
    const validation = await validateNativePlugin(output);
    expect((await loadNativePlugin(validation.plugin!)).components.skills?.value).toHaveLength(1);
  });

  it("cleans a failed candidate without publishing an installable partial directory", async () => {
    const { source, root, output } = await setup();
    await json(join(source, "mcp/servers.json"), { resource: "must not overwrite" });
    const { converter, inspection, plan } = await prepare(source);
    await expect(converter.convert({ inspection, plan, output, approvals: approvals(plan) })).rejects.toThrow(/conflicts/i);
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("rejects an unsupported-only plugin without creating output even when losses are approved", async () => {
    const { source, root, output } = await setup();
    await rm(join(source, "skills"), { recursive: true, force: true });
    await rm(join(source, ".mcp.json"));
    await json(join(source, ".codex-plugin/plugin.json"), { name: "apps-only", apps: "./.app.json" });
    const { converter, inspection, plan } = await prepare(source);
    await expect(converter.convert({ inspection, plan, output, approvals: approvals(plan) })).rejects.toThrow(/no convertible components/i);
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("detects a portable-only plugin and refuses unknown portable schema versions", async () => {
    const { source } = await setup();
    await rm(join(source, ".codex-plugin"), { recursive: true, force: true });
    await json(join(source, "plugin.json"), { $schema: portableSchema, name: "portable-only" });
    const registry = createBuiltinConverterRegistry();
    expect((await registry.detect(source)).converter.id).toBe("codex");
    await json(join(source, "plugin.json"), { $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json", name: "future" });
    await expect(registry.detect(source, "codex")).rejects.toThrow(/does not match/i);
  });

  it("does not activate unplanned Markdown files as skills", async () => {
    const { source, output } = await setup();
    await writeFile(join(source, "skills/README.md"), "---\nname: unplanned\ndescription: Not a declared skill\n---\nDo something else\n");
    const { converter, inspection, plan } = await prepare(source);
    await converter.convert({ inspection, plan, output, approvals: approvals(plan) });
    const validation = await validateNativePlugin(output);
    expect((await loadNativePlugin(validation.plugin!)).components.skills?.value?.map(skill => skill.name)).toEqual(["review"]);
  });

  it("reports unknown portable root fields and vendor extensions before discarding them", async () => {
    const { source, output } = await setup();
    await json(join(source, "plugin.json"), { $schema: portableSchema, name: "vendor", customRuntime: { mode: "special" }, extensions: { "com.openai": {}, "com.vendor": { hooks: { start: "script" } } } });
    const { converter, inspection, plan } = await prepare(source);
    expect(plan.items).toContainEqual(expect.objectContaining({ sourcePath: "plugin.json#extensions.com.vendor", fidelity: "unsupported" }));
    expect(plan.items).toContainEqual(expect.objectContaining({ sourcePath: "plugin.json#customRuntime", fidelity: "unsupported" }));
    await expect(converter.convert({ inspection, plan, output })).rejects.toThrow(/approval/i);
  });

  it("preserves ordinary resources whose names resemble inactive configuration files", async () => {
    const { source, output } = await setup();
    await rm(join(source, ".mcp.json"));
    await json(join(source, ".codex-plugin/plugin.json"), { name: "resources", skills: "./skills" });
    await json(join(source, "plugin.json"), { reviewRules: ["must check authorization"] });
    await json(join(source, "mcp/servers.json"), { resource: "keep this" });
    const { converter, inspection, plan } = await prepare(source);
    await converter.convert({ inspection, plan, output, approvals: approvals(plan) });
    expect(JSON.parse(await readFile(join(output, "plugin.json"), "utf8"))).toEqual({ reviewRules: ["must check authorization"] });
    expect(JSON.parse(await readFile(join(output, "mcp/servers.json"), "utf8"))).toEqual({ resource: "keep this" });
  });
});
