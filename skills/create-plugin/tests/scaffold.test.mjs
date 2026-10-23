import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access, rm, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPlugin } from "../scripts/create-plugin.mjs";

const work = await mkdtemp(join(tmpdir(), "weather-starter-scaffold-"));
after(() => rm(work, { recursive: true, force: true }));
test("generates distinct standalone native and MCP projects with one backend", async () => {
  for (const backend of ["native", "mcp"]) {
    const root = join(work, backend);
    const result = await createPlugin({ dir: root, id: `example.${backend}-weather`, name: `${backend}-weather`, backend });
    const config = JSON.parse(await readFile(join(root, "plugin.config.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(root, ".vykor-plugin/plugin.json"), "utf8"));
    assert.equal(config.backend, backend);
    assert.equal(manifest.id, `example.${backend}-weather`);
    assert.equal(manifest.version, "1.0.0");
    assert.ok(manifest.icon.startsWith("data:image/"));
    assert.equal(manifest.prompts.length, 2);
    assert.equal(manifest.components.tools?.length ?? 0, backend === "native" ? 3 : 0);
    assert.equal(manifest.components.mcpServers?.length ?? 0, backend === "mcp" ? 1 : 0);
    await access(join(root, "adapters", backend));
    await assert.rejects(access(join(root, "adapters", backend === "native" ? "mcp" : "native")));
    assert.equal(result.root, root);
    const { createPluginAppClient } = await import(pathToFileURL(join(root, 'ui/app-client.mjs')).href);
    const { createWeatherTools } = await import(pathToFileURL(join(root, 'src/app-tools.mjs')).href);
    const { names } = await import(pathToFileURL(join(root, 'src/identity.mjs')).href);
    const requests = [];
    const response = { content: [], structuredContent: { kind: 'places', places: [] } };
    const client = createPluginAppClient({ async callServerTool(request) { requests.push(request); return response; } });
    assert.equal(await client.call(createWeatherTools(names).SearchPlaces, { query: 'Shanghai' }), response);
    assert.deepEqual(requests, [{ name: `${config.toolPrefix}SearchPlaces`, arguments: { query: 'Shanghai' } }]);
    await access(join(root, 'ui/app-client.d.mts'));
    await assert.rejects(createPlugin({ dir: root, id: manifest.id, name: manifest.name, backend }), /exist|存在/i);
  }
  const native = JSON.parse(await readFile(join(work, "native/plugin.config.json"), "utf8"));
  const mcp = JSON.parse(await readFile(join(work, "mcp/plugin.config.json"), "utf8"));
  assert.notEqual(native.toolPrefix, mcp.toolPrefix);
});
test("MCP service names are unique per identity and generated tool names fit provider limits", async () => {
  const servers = [];
  for (let index = 0; index < 2; index++) {
    const root = join(work, `unique-${index}`);
    const { config } = await createPlugin({ dir: root, id: `example.long-${index}`, name: "weather-" + "x".repeat(50), backend: "mcp" });
    const mcp = JSON.parse(await readFile(join(root, "mcp.json"), "utf8"));
    const apps = JSON.parse(await readFile(join(root, "ui/apps.json"), "utf8"));
    servers.push(apps.backends[0].server);
    assert.equal(Object.keys(mcp.servers)[0], apps.backends[0].server);
    assert.ok((config.toolPrefix + "ApplyPlanOperations").length <= 64);
    assert.ok((`mcp__${apps.backends[0].server}__${config.toolPrefix}ApplyPlanOperations`).length <= 64);
  }
  assert.notEqual(servers[0], servers[1]);
});
test("rejects unsafe or invalid identities before creating files", async () => {
  for (const change of [{ id: "../escape" }, { name: "bad name" }, { backend: "unknown" }, { version: "1.0.0-beta" }]) {
    const root = join(work, `invalid-${Object.keys(change)[0]}`);
    await assert.rejects(createPlugin({ dir: root, id: "example.weather", name: "weather", backend: "native", ...change }));
    await assert.rejects(access(root));
  }
});

test("a separately installed Skill works beneath a parent named dist", async () => {
  const distribution = fileURLToPath(new URL("../", import.meta.url));
  const installed = join(work, 'dist', 'create-plugin');
  await mkdir(installed, { recursive: true });
  await cp(distribution, installed, { recursive: true, filter: source => !relative(distribution, source).split(/[\\/]/).some(part => ['node_modules', 'dist', '.git'].includes(part)) });
  const { createPlugin: createInstalledPlugin } = await import(pathToFileURL(join(installed, 'scripts/create-plugin.mjs')).href);
  const root = join(work, 'from-installed-skill');
  await createInstalledPlugin({ dir: root, id: 'example.portable', name: 'portable', backend: 'native' });
  await access(join(root, 'src/service.mjs'));
  await access(join(root, 'package.json'));
});
