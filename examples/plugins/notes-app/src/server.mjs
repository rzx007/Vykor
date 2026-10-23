import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError, ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListResourceTemplatesRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Notes } from "./notes.mjs";
import { noteTools } from './app-tools.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.VYKOR_NOTES_DATA_DIR, session = process.env.VYKOR_NOTES_SESSION;
if (!process.env.VYKOR_NOTES_FILE && (!dataDir || !session || !/^[a-f0-9]{64}$/.test(session))) throw new Error("Notes requires the host-bound plugin data directory and session");
const notes = new Notes(process.env.VYKOR_NOTES_FILE ?? join(dataDir, "sessions", session, "welcome.json"));
const server = new Server({ name: "notes-app", version: "1.0.0" }, { capabilities: { tools: {}, resources: { subscribe: true } } });
const subscriptions = new Set();
const ui = { resourceUri: "ui://notes/editor", visibility: ["model", "app"] };
const schema = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const writes = { expectedRevision: { type: "integer", minimum: 0 }, operationId: { type: "string", minLength: 1, maxLength: 128 }, text: { type: "string", maxLength: 48000 } };
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    { name: noteTools.read.name, description: "Read the shared welcome note and current document revision before editing.", inputSchema: schema({}), _meta: { ui }, annotations: { readOnlyHint: true } },
    { name: noteTools.apply.name, description: "Replace an exact UTF-16 selection in the shared note. Requires the observed document revision and a new operationId. On conflict read and reconcile; do not blindly retry.", inputSchema: schema({ ...writes, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 0 } }), _meta: { ui } },
    { name: noteTools.list.name, description: "List notes", inputSchema: schema({}), _meta: { ui: { visibility: ["app"] } }, annotations: { readOnlyHint: true } },
    { name: noteTools.save.name, description: "Manually save the complete draft", inputSchema: schema(writes), _meta: { ui: { ...ui, visibility: ["app"] } } },
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const { name, arguments: args = {} } = request.params;
    const data = name === noteTools.read.name ? notes.read() : name === noteTools.list.name ? { notes: [{ id: "welcome", uri: "notes://welcome", title: "协作笔记" }] }
      : name === noteTools.save.name ? notes.write(args, "save") : name === noteTools.apply.name ? notes.write(args, "replace") : undefined;
    if (!data) throw new Error("unknown_tool");
    if (data.saved && !data.duplicate && subscriptions.has("notes://welcome")) await server.notification({ method: "notifications/resources/updated", params: { uri: "notes://welcome" } });
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, _meta: { editor: "notes-app" } };
  } catch (error) { return { content: [{ type: "text", text: error.message }], isError: true }; }
});
server.setRequestHandler(ListResourcesRequestSchema, () => ({
  resources: [
    { uri: "ui://notes/editor", name: "协作笔记", mimeType: "text/html;profile=mcp-app" },
    { uri: "notes://welcome", name: "Welcome", mimeType: "application/json" },
  ]
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
server.setRequestHandler(ReadResourceRequestSchema, request => {
  const uri = request.params.uri;
  if (uri === "ui://notes/editor") return { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: readFileSync(join(root, "ui/panel.html"), "utf8") }] };
  if (uri === "notes://welcome") return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(notes.read()) }] };
  throw new Error("unknown_resource");
});
server.setRequestHandler(SubscribeRequestSchema, request => { if (request.params.uri !== "notes://welcome") throw new McpError(ErrorCode.InvalidParams, "resource_not_subscribable"); subscriptions.add(request.params.uri); return {}; });
server.setRequestHandler(UnsubscribeRequestSchema, request => { subscriptions.delete(request.params.uri); return {}; });
await server.connect(new StdioServerTransport());
