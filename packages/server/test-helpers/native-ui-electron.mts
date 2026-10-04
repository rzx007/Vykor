import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createDefaultNodeAgent } from "@vykor/agent-runtime"
import { installLocalNativePlugin } from "@vykor/plugins"
import { SessionStore } from "@vykor/services"
import { readPluginUiInstance } from "@vykor/protocol"
import { VykorHttpServer } from "../src/http/server.js"
import { createDefaultPluginService } from "../src/application/default-services/plugin-service.js"

const workspace = process.env.VYKOR_UI_TEST_ROOT!
const reference = process.env.VYKOR_UI_TEST_REFERENCE === "1"
const pluginId = reference ? "example.text-inspector" : "test.ui-electron"
process.send?.({ stage: "installing" })
const root = mkdtempSync(join(workspace, ".superpowers/sdd/2026-10-03-native-plugin-ui-a3/native-"))
process.env.VYKOR_CONFIG_DIR = join(root, "config")
const source = reference ? join(workspace, "examples/plugins/text-inspector") : join(root, "source")
if (!reference) {
for (const folder of [".vykor-plugin", "ui", "tools"]) mkdirSync(join(source, folder), { recursive: true })
const assets = join(workspace, "tests/browser-plugin-ui-sdk/dist/assets")
const sdk = readFileSync(join(assets, readdirSync(assets).find(name => name.endsWith(".js"))!), "utf8").replace(/<\/script/gi, "<\\/script")
writeFileSync(join(source, ".vykor-plugin/plugin.json"), JSON.stringify({ schemaVersion: 1, id: "test.ui-electron",
  name: "ui-electron", version: "1.0.0", components: { tools: ["./tools/index.mjs"], ui: ["./ui/manifest.json"] } }))
writeFileSync(join(source, "ui/manifest.json"), JSON.stringify({ schemaVersion: 1, components: [{
  id: "panel", title: "检查结果", entry: "./ui/panel.html", surfaces: ["tool-result", "session-sidebar"],
  actions: [{ id: "apply", label: "应用检查结果", tool: "NativeAction", completion: "keep-open" }],
}] }))
const portProbe = "<script>window.testReplies=[];window.addEventListener('message',event=>{" +
  "if(event.source===parent&&event.data?.type==='plugin-ui-init'&&event.ports[0]){" +
  "window.testMount=event.data.mountId;window.testPort=event.ports[0];window.testPort.addEventListener('message',e=>{" +
  "const r=JSON.parse(e.data);if(r.id?.startsWith('attack'))window.testReplies.push(r);});}});</script>"
writeFileSync(join(source, "ui/panel.html"), '<p id="status">waiting</p><button id="apply">Apply</button><p id="result"></p>' + portProbe + "<script>" + sdk + "</script>")
writeFileSync(join(source, "tools/index.mjs"), `
  import { existsSync, readFileSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  export function registerTools() { return [
    { name: "NativeInspect", description: "inspect", inputSchema: { type: "object" }, async invoke() {
      return { content: [{ type: "text", text: "原始结果，不应消失" }],
        metadata: { ui: { schemaVersion: 1, componentId: "panel", data: { count: 1 } } } };
    } },
    { name: "NativeAction", description: "apply", inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
      async invoke(input, context) {
        const effects = join(context.cwd, "effects");
        writeFileSync(effects, String((existsSync(effects) ? Number(readFileSync(effects, "utf8")) : 0) + 1));
        if (existsSync(join(context.cwd, "wait-action"))) await new Promise((resolve, reject) => {
          context.signal.throwIfAborted();
          context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
        return { content: [{ type: "text", text: "Applied" }],
          metadata: { ui: { schemaVersion: 1, componentId: "panel", data: { count: 0 } } } };
      } }
  ]; }
`)
}
await installLocalNativePlugin({ sourcePath: source, cwd: root, scope: "user", approvedPermissions: ["ui:render", "ui:invoke-own-tools"] })
process.send?.({ stage: "assembling" })
const settings = { apiFormat: "openai" as const, model: "local-fixture", maxTurns: 3,
  permission: { mode: "full_auto" as const }, sandbox: { enabled: false }, memory: { enabled: false } }
const store = new SessionStore({ path: join(root, "sessions.db") })
let modelCalls = 0
const token = randomUUID()
const server = new VykorHttpServer({ store, token, settings, logger: () => {},
  services: { plugin: createDefaultPluginService({ current: settings }) },
  createAgent: async ({ options }) => createDefaultNodeAgent({ ...options,
    capabilityOverrides: { ...options.capabilityOverrides, terminal: false, memory: false },
    client: { async *streamMessage() {
      if (++modelCalls === 1) {
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "source-call",
          name: reference ? "TextInspectorCheck" : "NativeInspect", input: reference ? { text: "ok  \n\titem\n" } : {} } }
        yield { type: "complete", stopReason: "tool_use" }
      } else { yield { type: "text_delta", delta: "Done" }; yield { type: "complete", stopReason: "end_turn" } }
    } },
  }),
})
await server.application.ready()
process.send?.({ stage: "source model" })
const session = store.sessions.create({ id: "session", cwd: root, model: "local-fixture", metadata: { runtime: { model: "local-fixture" } } })
const admitted = await server.application.interactions.admitPrompt(session.id, { items: [
  { type: "text", text: "Inspect" }, { type: "capability", kind: "plugin", pluginId, displayName: "Electron fixture" },
] })
await server.application.runControl.waitForRuns([admitted.run!.id])
process.send?.({ stage: "listening" })
const instance = store.conversations.listMessageParts(session.id).map(part => readPluginUiInstance(part.metadata)).find(Boolean)!
const listening = await server.listen({ port: 0 })
process.send?.({ baseUrl: listening.url, token, root, sessionId: session.id, instanceId: instance.instanceId })
process.on("message", async message => {
  if (message === "close") {
    await server.close()
    store.close()
    process.send?.({ result: "closed", modelCalls })
    process.exit(0)
  }
})
