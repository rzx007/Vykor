import { Hono, type Context } from "hono";
import { pluginAppToolInput, pluginAppConversationInput } from "../mappers/plugin-apps.js";
import { PLUGIN_APP_DATA_LIMITS, copyPluginAppJson, parsePluginAppSource, parsePluginAppToolRequest, parsePluginAppConversationRequest } from "@vykor/protocol";
import type { PluginAppRuntimeLease } from "@vykor/protocol";
import type { assemblePluginApps } from "../../application/session/plugin-app-assembly.js";
import type { PluginAppConversationService } from "../../application/session/plugin-app-conversation-service.js";
import { ApplicationError } from "../../shared/application-error.js";
import { PluginAppAdmissionError } from "../../application/session/plugin-app-admission-error.js";
import { applicationErrorResponse, jsonResponse, readJson, SSE_HEADERS } from "../support.js";

export function createSessionPluginAppsRoutes(runtime: ReturnType<typeof assemblePluginApps>, conversation: PluginAppConversationService): Hono {
  const source = (c: Context) => {
    if (new URL(c.req.url).search) throw new ApplicationError(400, "应用入口不接受查询参数");
    return parsePluginAppSource({ sessionId: c.req.param("sessionId"), appId: c.req.param("appId") });
  };
  const fixedSource = (c: Context, input: { source: { sessionId: string; appId: string } }) => {
    const route = source(c);
    if (route.sessionId !== input.source.sessionId || route.appId !== input.source.appId) throw new ApplicationError(400, "应用来源与地址不符");
    return route;
  };
  const resources = async (c: Context) => {
    const body = copyPluginAppJson(await readJson(c), 16 * 1024) as unknown as { lease: PluginAppRuntimeLease; uri?: string; cursor?: string };
    if (!body || typeof body !== "object" || (body.lease !== undefined && (!body.lease || typeof body.lease.token !== "string"
      || typeof body.lease.backendGeneration !== "string"))
      || Object.keys(body).some(k => !["lease", "uri", "cursor"].includes(k))) throw new ApplicationError(400, "资源请求无效");
    return { body, port: await runtime.resources(source(c), body.lease) };
  };
  const routes = new Hono();
  routes.onError(error => error instanceof PluginAppAdmissionError ? jsonResponse(error.rejection, 409) : applicationErrorResponse(error instanceof ApplicationError ? error
    : new ApplicationError(error.message.startsWith("plugin_app_invalid") || error.message.startsWith("plugin_app_json") ? 400 : 409, "应用请求无效或已失效")));
  return routes
    .post("/plugin-app-notifications/stream", async c => {
      const input = await readJson(c);
      if (!input || typeof input !== "object" || !("watches" in input) || !Array.isArray(input.watches) || input.watches.length > 8)
        throw new ApplicationError(400, "应用订阅无效");
      const watches = await Promise.all(input.watches.map(async (value: unknown) => {
        const item = copyPluginAppJson(value, 32 * 1024);
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApplicationError(400, "应用订阅无效");
        const from = parsePluginAppSource(item.source), lease = item.lease;
        if (!lease || typeof lease !== "object" || Array.isArray(lease) || typeof lease.token !== "string" || typeof lease.backendGeneration !== "string"
          || !Number.isSafeInteger(item.leaseGeneration) || typeof item.leaseGeneration !== "number" || item.leaseGeneration < 0
          || !Array.isArray(item.uris) || item.uris.length > 32 || item.uris.some(uri => typeof uri !== "string" || !uri || uri.length > 4096))
          throw new ApplicationError(400, "应用订阅无效");
        const uris = item.uris.filter((uri): uri is string => typeof uri === "string");
        return { source: from, leaseGeneration: item.leaseGeneration, uris, port: await runtime.resources(from, { token: lease.token, backendGeneration: lease.backendGeneration }) };
      }));
      const stream = runtime.notifications.stream(async (emit, signal) => {
        for (const watch of watches) for (const uri of watch.uris) {
          signal.throwIfAborted();
          const stop = await watch.port.subscribeResource(uri, () => emit({ kind: "resource-updated", runtimeEpoch: runtime.notifications.runtimeEpoch,
            appId: watch.source.appId, leaseGeneration: watch.leaseGeneration, uri }), signal);
          if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
        }
      }, c.req.raw.signal);
      return new Response(stream, { headers: SSE_HEADERS });
    })
    .get("/:sessionId/plugin-apps/catalog", async c => jsonResponse({ backends: await runtime.apps.listSurfaces(c.req.param("sessionId")) }))
    .get("/:sessionId/plugin-apps", async c => jsonResponse({ apps: await runtime.apps.list(c.req.param("sessionId")) }))
    .post("/:sessionId/plugin-apps/open", async c => {
      const input = await readJson(c), id = c.req.param("sessionId");
      return jsonResponse(await runtime.mutate(id, () => runtime.apps.open(id, input)));
    })
    .post("/:sessionId/plugin-apps/open-tool-result", async c => {
      const input = await readJson(c), id = c.req.param("sessionId");
      if (!input || typeof input !== "object" || !("sourcePartId" in input) || typeof input.sourcePartId !== "string"
        || !input.sourcePartId || input.sourcePartId.length > 4096 || Object.keys(input).length !== 1) throw new ApplicationError(400, "工具结果入口无效");
      const sourcePartId = input.sourcePartId;
      return jsonResponse(await runtime.mutate(id, () => runtime.apps.openToolResult(id, sourcePartId)));
    })
    .post("/:sessionId/plugin-apps/:appId/initial-result", async c => {
      const input = await readJson(c);
      if (!input || typeof input !== "object" || !("sourcePartId" in input) || typeof input.sourcePartId !== "string"
        || !("lease" in input) || !input.lease || typeof input.lease !== "object"
        || !("token" in input.lease) || typeof input.lease.token !== "string"
        || !("backendGeneration" in input.lease) || typeof input.lease.backendGeneration !== "string"
        || Object.keys(input).some(key => !["lease", "sourcePartId"].includes(key))) throw new ApplicationError(400, "工具结果请求无效");
      return jsonResponse(await runtime.initialResult(source(c), { token: input.lease.token, backendGeneration: input.lease.backendGeneration }, input.sourcePartId));
    })
    .post("/:sessionId/plugin-apps/:appId/prepare", async c => jsonResponse(await runtime.apps.prepare(source(c))))
    .post("/:sessionId/plugin-apps/:appId/close", async c => {
      const input = await readJson(c), from = source(c);
      return jsonResponse({ app: await runtime.mutate(from.sessionId, async () => runtime.apps.close(from, input)) });
    })
    .post("/:sessionId/plugin-apps/:appId/actions", async c => {
      // Only app actions accept declared large payloads. Runtime still checks the captured tool's own quota.
      const request = parsePluginAppToolRequest(await readJson(c, undefined, PLUGIN_APP_DATA_LIMITS.maxArgsBytes + 16 * 1024));
      const response = await runtime.actions.invoke(pluginAppToolInput(fixedSource(c, request), request));
      return jsonResponse(response, ["pending", "running"].includes(response.receipt.status) ? 202 : 200);
    })
    .get("/:sessionId/plugin-apps/:appId/actions/:requestId", c => jsonResponse(runtime.actions.read(source(c), c.req.param("requestId"))))
    .post("/:sessionId/plugin-apps/:appId/actions/:requestId/cancel", async c => {
      const from = source(c);
      return jsonResponse(await runtime.mutate(from.sessionId, async () => runtime.actions.cancel(from, c.req.param("requestId"))));
    })
    .post("/:sessionId/plugin-apps/:appId/resources/read", async c => {
      const { body, port } = await resources(c);
      if (typeof body.uri !== "string" || !body.uri) throw new ApplicationError(400, "缺少资源 URI");
      return jsonResponse(await port.readResource(body.uri, c.req.raw.signal));
    })
    .post("/:sessionId/plugin-apps/:appId/resources/list", async c => {
      const { body, port } = await resources(c); return jsonResponse(await port.listResources(body.cursor, c.req.raw.signal));
    })
    .post("/:sessionId/plugin-apps/:appId/resource-templates/list", async c => {
      const { body, port } = await resources(c); return jsonResponse(await port.listResourceTemplates(body.cursor, c.req.raw.signal));
    })
    .post("/:sessionId/plugin-apps/:appId/conversation/submissions", async c => {
      const request = parsePluginAppConversationRequest(await readJson(c));
      return jsonResponse({ receipt: await conversation.submit(pluginAppConversationInput(fixedSource(c, request), request)) });
    })
    .get("/:sessionId/plugin-apps/:appId/conversation/submissions/:requestId", c => jsonResponse({ receipt: conversation.read(source(c), c.req.param("requestId")) }));
}
