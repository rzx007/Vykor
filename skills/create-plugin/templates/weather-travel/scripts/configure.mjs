import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { definitions } from "../src/tools.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = value => JSON.stringify(value, null, 2) + "\n";
const network = ["api.open-meteo.com", "geocoding-api.open-meteo.com"];
const icon = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="25" cy="25" r="13" fill="#d7e8f5"/><path d="M25 5v5M25 40v5M5 25h5M40 25h5M11 11l4 4M35 35l4 4M11 39l4-4M35 15l4-4" stroke="#356b8e" stroke-width="3" stroke-linecap="round"/><path d="M21 51h29a9 9 0 0 0 0-18 13 13 0 0 0-25-1 10 10 0 0 0-4 19Z" fill="#edf3f6" stroke="#356b8e" stroke-width="3"/></svg>').toString("base64");

export async function configure(root = defaultRoot) {
  const config = JSON.parse(await readFile(resolve(root, "plugin.config.json"), "utf8"));
  const name = key => `${config.toolPrefix}${key}`;
  const serverName = "p" + createHash("sha256").update(config.id).digest("hex").slice(0, 8);
  if (definitions.some(tool => (config.backend === "mcp" ? `mcp__${serverName}__` : "").length + name(tool.key).length > 64)) throw new Error("Tool name exceeds provider limit");
  const resourceUri = `ui://${config.name}/panel`;
  const policies = ["SavePlanDraft", "SetFavorite"].map(key => ({ tool: name(key), authorization: "plugin-data-write" }));
  const manifest = {
    schemaVersion: 1, id: config.id, name: config.name, version: config.version,
    displayName: config.displayName, license: "MIT", icon,
    description: "查询真实天气、比较城市，在右侧协作编辑出行备忘并确认导出。",
    introduction: "## 天气与出行\n\n搜索目的地，查看当前、七日与逐小时天气，并比较城市。出行备忘按版本自动保存；切换面板保留草稿，冲突时对照最新内容合并。\n\n选中天气日期或出行条目引用到聊天，助手读取最新版本后继续修改。导出到工作区需要单独确认。天气来自 Open-Meteo，免费端点仅供非商业评估；页面显示来源、时区及获取时间。",
    prompts: [
      { title: "看看目的地天气", prompt: `请用${config.displayName}查询杭州和苏州未来七天的天气，比较降雨情况，在右侧打开应用；说明天气来源和当地时间。` },
      { title: "整理出行备忘", prompt: `请先读取${config.displayName}当前出行备忘的最新版本，再根据我引用的条目整理安排，保留其他条目和原有 ID；不要直接导出文件。` },
    ],
    permissions: { pluginData: ["write"], network, filesystem: ["workspace:write"] },
    components: { apps: ["./ui/apps.json"], skills: ["./skills/weather/SKILL.md"] },
  };
  let backend;
  if (config.backend === "native") {
    manifest.runtime = { engine: "node", isolation: "process" };
    manifest.components.tools = [
      { entry: "./dist/native/network.mjs", runtime: "node", permissions: network.map(domain => `network:${domain}`) },
      { entry: "./dist/native/data.mjs", runtime: "node", permissions: [] },
      { entry: "./dist/native/export.mjs", runtime: "node", permissions: ["filesystem:workspace:write"] },
    ];
    backend = {
      id: "weather", kind: "native-tools", resources: [{ uri: resourceUri, entry: "./dist/ui/panel.html" }],
      tools: definitions.map(tool => ({ tool: name(tool.key), visibility: tool.visibility, ui: { resourceUri } })),
      toolPolicies: policies,
    };
  } else if (config.backend === "mcp") {
    manifest.components.mcpServers = ["./mcp.json"];
    backend = { id: "weather", kind: "mcp-server", server: serverName, toolPolicies: policies };
    await writeFile(resolve(root, "mcp.json"), json({ servers: { [serverName]: {
      type: "stdio", command: "node", args: ["dist/server.mjs"], cwd: "${VYKOR_PLUGIN_ROOT}",
      env: { VYKOR_WEATHER_DATA_DIR: "${VYKOR_PLUGIN_DATA_DIR}", VYKOR_WEATHER_SESSION: "${VYKOR_SESSION_ID}", VYKOR_WEATHER_WORKSPACE: "${VYKOR_WORKSPACE_ROOT}" },
    } } }));
  } else throw new Error("Unsupported backend");
  await mkdir(resolve(root, ".vykor-plugin"), { recursive: true });
  await mkdir(resolve(root, "ui"), { recursive: true });
  await writeFile(resolve(root, ".vykor-plugin/plugin.json"), json(manifest));
  await writeFile(resolve(root, "ui/apps.json"), json({ schemaVersion: 1, backends: [backend], surfaces: [
    { id: config.name, title: config.displayName, backend: "weather", resourceUri, availability: "session" },
  ] }));
  return manifest;
}
