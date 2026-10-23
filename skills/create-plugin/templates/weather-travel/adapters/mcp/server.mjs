import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createService } from '../../src/service.mjs';
import { config, names, resourceUri, planUri } from '../../src/identity.mjs';
import { definitions, toolError } from '../../src/tools.mjs';
import { MAX_DATA_BYTES } from '../../src/validation.mjs';

const favoritesUri = `${config.name}://favorites`;
function findPluginRoot() {
  let candidate = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(resolve(candidate, '.vykor-plugin', 'plugin.json')) || existsSync(resolve(candidate, 'plugin.config.json'))) return candidate;
    const parent = dirname(candidate); if (parent === candidate) throw new Error('Could not locate the installed plugin root'); candidate = parent;
  }
}
function mcpResult(data) { return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, _meta: { appData: data } }; }
function mcpError(error) { const result = toolError(error); return { ...mcpResult(result.metadata.appData), isError: true }; }

export function createServer(options = {}) {
  const service = createService({
    dataDir: options.dataDir ?? process.env.VYKOR_WEATHER_DATA_DIR,
    sessionId: options.sessionId,
    sessionKey: options.sessionKey ?? (options.sessionId === undefined ? process.env.VYKOR_WEATHER_SESSION : undefined),
    workspaceRoot: options.workspaceRoot ?? process.env.VYKOR_WEATHER_WORKSPACE,
    fetchImpl: options.fetchImpl, now: options.now,
  });
  const root = options.rootPath ?? findPluginRoot();
  const htmlPath = resolve(root, 'dist', 'ui', 'panel.html');
  const server = new Server({ name: config.name, version: config.version }, { capabilities: { tools: {}, resources: { subscribe: true } }, instructions: 'Read the trip before modifying fixed entry IDs. SavePlanDraft and SetFavorite are app-only. After an unknown write outcome, query GetOperation for the original operation ID; do not replay it.' });
  const subscriptions = new Map(), controller = new AbortController();
  const dataFor = uri => uri === planUri ? service.readPlan() : service.readFavorites();
  const isDataUri = uri => uri === planUri || uri === favoritesUri;
  let disposed = false, refreshing = false;
  async function refresh() {
    if (disposed || refreshing || !subscriptions.size) return;
    refreshing = true;
    try {
      for (const [uri, previous] of subscriptions) {
        const current = JSON.stringify(dataFor(uri));
        if (current !== previous) { subscriptions.set(uri, current); try { await server.sendResourceUpdated({ uri }); } catch {} }
      }
    } finally { refreshing = false; }
  }
  const timer = setInterval(() => { refresh().catch(() => {}); }, Math.max(20, options.pollInterval ?? 1000)); timer.unref();
  function dispose() { if (!disposed) { disposed = true; clearInterval(timer); controller.abort(); subscriptions.clear(); service.close(); } }
  const close = server.close.bind(server);
  server.close = async () => { try { await close(); } finally { dispose(); } };
  server.onclose = dispose;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: definitions.map(definition => ({ name: names[definition.key], description: definition.description, inputSchema: definition.inputSchema,
    annotations: { readOnlyHint: ['SearchPlaces', 'GetForecast', 'ReadPlan', 'ReadFavorites', 'GetOperation'].includes(definition.key), destructiveHint: definition.key === 'ExportPlan', openWorldHint: definition.group === 'network' },
    _meta: { ui: { resourceUri, visibility: definition.visibility } },
  })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const definition = definitions.find(definition => names[definition.key] === request.params.name);
    if (!definition) return mcpError(Object.assign(new Error('Unknown tool'), { code: 'unknown_tool' }));
    try {
      const data = await service.invoke(definition.key, request.params.arguments ?? {}, AbortSignal.any([extra.signal, controller.signal]));
      await refresh(); return mcpResult(data);
    } catch (error) { return mcpError(error); }
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [
    { uri: resourceUri, name: `${config.displayName} panel`, mimeType: 'text/html;profile=mcp-app' },
    { uri: planUri, name: 'Current session trip', description: 'Read-only snapshot. Use checked tools for changes.', mimeType: 'application/json' },
    { uri: favoritesUri, name: 'Shared favorite places', description: 'Read-only snapshot of saved favorites.', mimeType: 'application/json' },
  ] }));
  server.setRequestHandler(ReadResourceRequestSchema, request => {
    const uri = request.params.uri;
    if (uri === resourceUri) {
      if (!existsSync(htmlPath) || statSync(htmlPath).size > 2 * 1024 * 1024) throw new McpError(ErrorCode.InvalidRequest, 'Build the app HTML resource before opening the panel');
      return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: readFileSync(htmlPath, 'utf8'), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] };
    }
    if (!isDataUri(uri)) throw new McpError(ErrorCode.InvalidParams, 'Unknown resource URI');
    const text = JSON.stringify(dataFor(uri));
    if (Buffer.byteLength(text) > MAX_DATA_BYTES) throw new McpError(ErrorCode.InternalError, 'Resource exceeds the data limit');
    return { contents: [{ uri, mimeType: 'application/json', text }] };
  });
  server.setRequestHandler(SubscribeRequestSchema, request => {
    if (!isDataUri(request.params.uri)) throw new McpError(ErrorCode.InvalidParams, 'Only trip and favorites data resources support subscription');
    subscriptions.set(request.params.uri, JSON.stringify(dataFor(request.params.uri))); return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, request => { subscriptions.delete(request.params.uri); return {}; });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const server = createServer();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close().finally(() => process.exit(0)); });
    await server.connect(new StdioServerTransport());
  } catch (error) { process.stderr.write(`Weather MCP startup failed: ${error.message}\n`); process.exitCode = 1; }
}
