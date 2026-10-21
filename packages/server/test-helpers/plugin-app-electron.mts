import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { cp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installLocalNativePlugin } from "@vykor/plugins"
import { createDefaultNodeAgent } from "@vykor/agent-runtime"
import { SessionStore } from "@vykor/services"
import { VykorHttpServer } from "../src/http/server.js"
import { createDefaultPluginService } from "../src/application/default-services/plugin-service.js"
import { createDefaultSettingsService } from "../src/application/default-services/settings-service.js"
import { createDefaultModelService } from "../src/application/default-services/model-service.js"
import { installAppFixture } from "../../agent-runtime/test-helpers/plugin-app-fixture.js"
import { installNotesAppFixture } from "../../agent-runtime/test-helpers/notes-app-fixture.js"
const workspace = process.env.VYKOR_UI_TEST_ROOT!
const root = mkdtempSync(join(tmpdir(), "vykor-electron-app-"))
process.env.VYKOR_CONFIG_DIR = join(root, "config")
const kind = process.env.VYKOR_APP_BACKEND === "mcp-server" ? "mcp-server" : "native-tools"
const bundle = readFileSync(process.env.VYKOR_APP_PAGE_BUNDLE!, "utf8").replace(/<\/script/gi, "<\\/script")
const html = `<!doctype html><html><body><input id="draft"><button id="save">Save</button><button id="wait">Wait</button><button id="cancel">Cancel</button><pre id="result"></pre><script>window.fixtureTool=${JSON.stringify(kind === "native-tools" ? "SaveDocument" : "save")};${bundle}</script></body></html>`
const realInspector = process.env.VYKOR_APP_BACKEND === "text-inspector"
const realNotes = process.env.VYKOR_APP_BACKEND === "notes-app"
const fixture = realNotes ? await installNotesAppFixture(root, false, join(workspace, "examples/plugins/notes-app")) : realInspector ? await (async () => {
  const sourcePath = join(root, "text-inspector")
  await cp(join(workspace, "examples/plugins/text-inspector"), sourcePath, { recursive: true,
    filter: path => !path.split(/[\\/]/).includes("node_modules") })
  const installed = await installLocalNativePlugin({ sourcePath, cwd: root,
    scope: "user", approvedPermissions: ["ui:render", "ui:invoke-own-tools"] })
  if (installed.status !== "installed") throw new Error(JSON.stringify(installed))
  return { pluginId: "example.text-inspector", toolName: "TextInspectorCheck", effectFile: join(root, "effects") }
})() : await installAppFixture(root, kind, html)
const settings = { apiFormat: "openai" as const, provider: "fixture", model: "never", maxTurns: 2,
  customProviders: [{ id: "fixture", displayName: "Fixture", apiFormat: "openai" as const, baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "never", displayName: "Injected test model" }] }],
  permission: { mode: "full_access" as const }, sandbox: { enabled: false }, memory: { enabled: false } }
const store = new SessionStore({ path: join(root, "sessions.db") }), token = randomUUID()
let modelCalls = 0
const server = new VykorHttpServer({ store, token, settings, logger: () => {},
  services: { plugin: createDefaultPluginService({ current: settings }), settings: createDefaultSettingsService({ current: settings }),
    model: createDefaultModelService({ current: settings }) },
  createAgent: async ({ options }) => createDefaultNodeAgent({ ...options, approvalMode: "full_access",
    capabilityOverrides: { ...options.capabilityOverrides, terminal: false, memory: false },
    client: { async *streamMessage(params) {
      modelCalls++;
      if (realNotes && modelCalls === 1) {
        if (!JSON.stringify(params.messages).includes('selectedText')) throw new Error("Selection context did not reach original model input")
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "model-note-edit", name: "mcp__notes__apply_note_operations",
          input: { expectedRevision: 1, operationId: "model-edit", start: 0, end: 5, text: "together" } } }
        yield { type: "complete", stopReason: "tool_use" }
      } else { yield { type: "text_delta", delta: "Done" }; yield { type: "complete", stopReason: "end_turn" } }
    } },
  }),
})
await server.application.ready()
const session = store.sessions.create({ id: "app-session", cwd: root, model: "never", metadata: { runtime: { provider: "fixture", model: "never", approvalMode: "full_access" } } })
const listening = await server.listen({ port: 0 })
process.send?.({ baseUrl: listening.url, token, root, sessionId: session.id, pluginId: fixture.pluginId, toolName: fixture.toolName,
  effectFile: fixture.effectFile, surfaceId: realNotes ? "notes" : realInspector ? "text-inspector" : "editor" })
process.on("message", async message => {
  if (message === "close") { await server.close(); store.close(); process.send?.({ modelCalls }); process.exit(0) }
})
