import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createContext, runInContext } from "node:vm";
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
  expect(html).not.toMatch(/<(?:script|link|iframe)\b[^>]*(?:src|href)=/i);
  const manifest = JSON.parse(await readFile(join(plugin, "ui", "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ schemaVersion: 2, components: [{ surface: "session-sidebar" }] });
  expect(manifest.components[0].surfaces).toBeUndefined();
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
  expect(checked.metadata.ui.schemaVersion).toBe(2);
  expect(result.metadata.ui.schemaVersion).toBe(2);
});

it("uses the same current SDK/CSS in both distributions and communicates over its real wire", async () => {
  const sdk = await readFile(join(distribution, "assets/text-inspector/ui/sdk.js"), "utf8");
  expect(sdk).toBe(await readFile(fileURLToPath(new URL("../../../examples/plugins/text-inspector/ui/sdk.js", import.meta.url)), "utf8"));
  const styles = await readFile(fileURLToPath(new URL("../../plugins/src/ui-styles.css", import.meta.url)), "utf8");
  expect(await readFile(join(distribution, "assets/text-inspector/ui/styles.css"), "utf8")).toBe(styles);
  expect(await readFile(fileURLToPath(new URL("../../../examples/plugins/text-inspector/ui/styles.css", import.meta.url)), "utf8"))
    .toBe(styles);
  const mountId = "20000000-0000-4000-8000-000000000001";
  const snapshot = { instanceId: "10000000-0000-4000-8000-000000000001", revision: 1,
    status: "open", data: { choices: ["one", "two"] }, actions: [], readOnly: false, locale: "zh-CN", surface: "session-sidebar",
    appearance: { theme: "dark", colors: { background: "#111", foreground: "#fff", muted: "#222", mutedForeground: "#aaa",
      primary: "#eee", primaryForeground: "#111", accent: "#444", border: "#555", destructive: "#f00" }, fontFamily: "sans-serif", fontSizePx: 16, reducedMotion: true },
    capabilities: { draft: true, submit: true } };
  let initialize: (event: unknown) => void = () => {};
  const ready: unknown[] = [], requests: Array<Record<string, any>> = [];
  const parent = { postMessage: (value: unknown) => ready.push(value) };
  const window = { parent, addEventListener: (_: string, listener: typeof initialize) => { initialize = listener }, removeEventListener() {} };
  const variables = new Map<string, string>();
  const context = { window, structuredClone, TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask,
    CSS: { supports: () => true }, document: { documentElement: { style: { setProperty: (key: string, value: string) => variables.set(key, value) } } } };
  const realm = createContext(context);
  const inRealm = (value: unknown) => runInContext("JSON.parse(" + JSON.stringify(JSON.stringify(value)) + ")", realm);
  // Browser structuredClone returns objects in the calling realm. Node's injected
  // implementation would return host-realm objects, which strict record checks reject.
  realm.structuredClone = inRealm;
  const api = runInContext(sdk + "\nVykorPluginUi", realm);
  const connected = api.createPluginUiClient();
  expect(ready).toEqual([{ version: 2, type: "plugin-ui-ready" }]);
  const port = { onmessage: null as null | ((event: { data: string }) => void), onmessageerror: null, start() {}, close() {},
    postMessage(wire: string) {
      const request = JSON.parse(wire); requests.push(request);
      const result = request.method === "getSnapshot" ? snapshot : { kind: "conversation", mode: "draft", instanceId: snapshot.instanceId, revision: 1, added: true };
      queueMicrotask(() => port.onmessage?.({ data: JSON.stringify({ version: 2, mountId, id: request.id, result }) }));
    } };
  initialize({ source: parent, data: inRealm({ version: 2, type: "plugin-ui-init", mountId }), ports: [port] });
  port.onmessage!({ data: JSON.stringify({ version: 2, mountId, type: "snapshot", snapshot }) });
  const client = await connected;
  expect(await client.getSnapshot()).toEqual(snapshot);
  api.applyPluginUiAppearance(inRealm(snapshot.appearance));
  expect(variables.get("--ohs-background")).toBe("#111");
  expect(variables.get("--ohs-font-size")).toBe("16px");
  expect(variables.get("--ohs-motion-duration")).toBe("0ms");
  expect(await client.requestConversation({ mode: "draft", expectedRevision: 1, text: "Explain", data: { selection: "two" } }))
    .toMatchObject({ kind: "conversation", mode: "draft", added: true });
  expect(requests[1]).toMatchObject({ version: 2, mountId, method: "requestConversation",
    params: { mode: "draft", expectedRevision: 1, text: "Explain", data: { selection: "two" } } });
  client.dispose();
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
