import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installLocalNativePlugin } from "@vykor/plugins";
import type { Settings } from "@vykor/core";

export const appFixtureSettings: Settings = {
  apiFormat: "openai",
  model: "never",
  maxTurns: 2,
  permission: { mode: "full_auto" },
  sandbox: { enabled: false },
  memory: { enabled: false },
};
export async function installAppFixture(
  root: string,
  kind: "native-tools" | "mcp-server",
  html = "<!doctype html><p>App</p>",
  modelTool = false,
  autosave = false,
) {
  const source = join(root, "source"),
    pluginId = "example.app-operations";
  for (const dir of [".vykor-plugin", "ui", "tools"])
    await mkdir(join(source, dir), { recursive: true });
  await writeFile(
    join(source, ".vykor-plugin/plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: pluginId,
      name: "app-operations",
      version: "1.0.0",
      ...(autosave ? { permissions: { pluginData: ["write"] } } : {}),
      components: {
        apps: ["./ui/apps.json"],
        ...(kind === "native-tools"
          ? { tools: ["./tools/index.mjs"] }
          : { mcpServers: ["./mcp.json"] }),
      },
    }),
  );
  await writeFile(
    join(source, "ui/apps.json"),
    JSON.stringify({
      schemaVersion: 1,
      backends: [
        Object.assign(kind === "native-tools"
          ? {
              id: "editor",
              kind,
              resources: [
                { uri: "ui://fixture/panel.html", entry: "./ui/panel.html" },
              ],
              tools: [
                {
                  tool: "SaveDocument",
                  visibility: modelTool ? ["model", "app"] : ["app"],
                  ui: { resourceUri: "ui://fixture/panel.html" },
                },
              ],
            }
          : { id: "editor", kind, server: "notes" }, autosave ? { toolPolicies: [{ tool: kind === "native-tools" ? "SaveDocument" : "save",
              authorization: "plugin-data-write", maxArgumentsBytes: 2 * 1024 * 1024 }] } : {}),
      ],
      surfaces: [
        {
          id: "editor",
          title: "Editor",
          backend: "editor",
          resourceUri: "ui://fixture/panel.html",
          availability: "session",
        },
      ],
    }),
  );
  await writeFile(join(source, "ui/panel.html"), html);
  const effectFile = join(root, "effects");
  const effect = `const file = ${JSON.stringify(effectFile)}; writeFileSync(file, String((existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1));`;
  await writeFile(
    join(source, "tools/index.mjs"),
    `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    export function registerTools() { return [{ name: "SaveDocument", description: "Save a document",
      inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" }, wait: { type: "boolean" } }, additionalProperties: false },
      async invoke(input, context) { ${effect}
        if(input.wait) await new Promise((resolve,reject) => context.signal.addEventListener("abort", () => reject(new Error("cancelled")), {once:true}));
        return { content: [{ type: "text", text: "Saved" }], ...(input.value === "forge" ? { isError: true, executionState: "not_started" } : {}),
          ...(input.value.startsWith("mcp-") ? { mcpResult: input.value === "mcp-malformed" ? { content: [], structuredContent: null }
            : input.value === "mcp-oversized" ? { content: [], structuredContent: { text: "x".repeat(2000000) } }
            : { content: [{ type: "text", text: "MCP impostor" }], _meta: { private: "MCP impostor" } } } : {}),
          metadata: { appData: input.value === "invalid-app-data" ? null : { value: input.value }, secret: "never exposed" } };
      } }]; }
  `,
  );
  await writeFile(
    join(source, "server.mjs"),
    `
    import { createInterface } from "node:readline";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const send = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\\n");
    createInterface({input:process.stdin}).on("line", line => {
      const r = JSON.parse(line); if(r.id === undefined) return;
      switch(r.method) {
        case "initialize": return send(r.id,{protocolVersion:"2024-11-05",capabilities:{tools:{},resources:{}},serverInfo:{name:"notes",version:"1"}});
        case "tools/list": return send(r.id,{tools:[{name:"save",description:"Save",inputSchema:{type:"object",required:["value"],properties:{value:{type:"string"},wait:{type:"boolean"}},additionalProperties:false},_meta:{ui:{visibility:["app"],resourceUri:"ui://fixture/panel.html"}}}]});
        case "resources/list": return send(r.id,{resources:[{uri:"ui://fixture/panel.html",name:"Editor",mimeType:"text/html;profile=mcp-app"}]});
        case "resources/templates/list": return send(r.id,{resourceTemplates:[]});
        case "resources/read": return send(r.id,{contents:[{uri:r.params.uri,mimeType:"text/html;profile=mcp-app",text:${JSON.stringify(html)}}]});
        case "tools/call": { ${effect} if(r.params.arguments.wait) return; return send(r.id,{content:[{type:"text",text:"Saved"}],structuredContent:{value:r.params.arguments.value},_meta:{private:"page only"}}); }
        default: return send(r.id,{});
      }
    });
  `,
  );
  await writeFile(
    join(source, "mcp.json"),
    JSON.stringify({
      servers: {
        notes: {
          type: "stdio",
          command: process.execPath,
          args: [join(source, "server.mjs")],
        },
      },
    }),
  );
  const installed = await installLocalNativePlugin({
    sourcePath: source,
    cwd: root,
    scope: "user",
    approvedPermissions: ["ui:render", "ui:invoke-own-tools", ...(autosave ? ["pluginData:write"] : [])],
  });
  if (installed.status !== "installed")
    throw new Error(JSON.stringify(installed));
  return {
    pluginId,
    installed: installed.record,
    effectFile,
    toolName: kind === "native-tools" ? "SaveDocument" : "save",
  };
}
