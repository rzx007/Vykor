import { readFile, lstat } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { definitions } from "../src/tools.mjs";

export async function validate(root = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const read = async file => JSON.parse(await readFile(resolve(root, file), "utf8"));
  const config = await read("plugin.config.json");
  const manifest = await read(".vykor-plugin/plugin.json");
  const pkg = await read("package.json");
  const lock = await read("package-lock.json");
  if (manifest.id !== config.id || manifest.name !== config.name || manifest.version !== config.version || pkg.version !== config.version || lock.version !== config.version || lock.packages[""].version !== config.version)
    throw new Error("Identity or package version mismatch");
  if (manifest.schemaVersion !== 1 || !manifest.icon?.startsWith("data:image/") || !manifest.prompts?.length)
    throw new Error("Missing manifest presentation");
  async function local(file) {
    if (!file.startsWith("./") || file.includes("\\") || file.split("/").includes("..")) throw new Error("Invalid component path");
    const path = resolve(root, file), rel = relative(root, path);
    if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Escaping component path");
    for (const part of rel.split(/[\\/]/).reduce((paths, part) => [...paths, resolve(paths.at(-1) ?? root, part)], []))
      if ((await lstat(part)).isSymbolicLink()) throw new Error("Linked component path");
    if (!(await lstat(path)).isFile()) throw new Error("Missing component file");
  }
  for (const entries of Object.values(manifest.components)) for (const entry of entries) await local(typeof entry === "string" ? entry : entry.entry);
  const apps = await read("ui/apps.json"), backend = apps.backends[0];
  if (apps.backends.length !== 1 || apps.surfaces.length !== 1 || backend.kind !== (config.backend === "native" ? "native-tools" : "mcp-server")) throw new Error("Wrong App backend");
  const policies = backend.toolPolicies;
  for (const policy of policies) {
    const tool = definitions.find(tool => `${config.toolPrefix}${tool.key}` === policy.tool);
    if (!tool || tool.visibility.length !== 1 || tool.visibility[0] !== "app" || policy.authorization !== "plugin-data-write") throw new Error("Unsafe autosave tool policy");
  }
  if (policies.length !== 2 || manifest.permissions.pluginData?.[0] !== "write") throw new Error("Missing finite save authorization");
  if (config.backend === "native") {
    if (manifest.components.tools.length !== 3 || manifest.components.mcpServers) throw new Error("Mixed backends");
    if (backend.tools.length !== definitions.length) throw new Error("Missing App tool bindings");
  } else {
    if (manifest.components.tools || manifest.components.mcpServers.length !== 1) throw new Error("Mixed backends");
    const mcp = await read("mcp.json");
    const serverName = "p" + createHash("sha256").update(config.id).digest("hex").slice(0, 8);
    if (backend.server !== serverName || Object.keys(mcp.servers).length !== 1 || mcp.servers[backend.server]?.cwd !== "${VYKOR_PLUGIN_ROOT}") throw new Error("Missing unique host binding");
    await local("./dist/server.mjs");
  }
  await local("./dist/ui/panel.html");
  const html = await readFile(resolve(root, "dist/ui/panel.html"), "utf8");
  if (Buffer.byteLength(html) > 16 * 1024 * 1024 || /<(?:script|link|iframe)\b[^>]*(?:src|href)\s*=/i.test(html)) throw new Error("App is not offline");
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validate();
  console.log("Standalone package checks passed; use vk plugin validate for host admission validation.");
}
