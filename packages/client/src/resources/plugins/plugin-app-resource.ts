import { parsePluginAppSource, parsePluginAppToolRequest, parsePluginAppConversationRequest, parseOpenPluginAppInput, parseClosePluginAppInput, type PluginAppToolRequest, type PluginAppConversationRequest, type PluginAppSource, type PluginAppRuntimeLease, type PluginAppRecord, type PluginAppResponse, type PluginAppListResponse, type PluginAppActionResponse, type PluginAppSubmissionReceipt, type OpenPluginAppInput, type ClosePluginAppInput } from "@vykor/protocol";
import type { HttpTransport } from "../../transport/http-transport.js";
import { streamServerSentEvents } from "../../transport/sse-transport.js";
import type { PluginAppResourceNotice, PluginAppResourceWatch } from "@vykor/protocol";

function path(value: PluginAppSource): string {
  const source = parsePluginAppSource(value);
  return `/sessions/${encodeURIComponent(source.sessionId)}/plugin-apps/${encodeURIComponent(source.appId)}`;
}
export class PluginAppResource {
  constructor(private readonly transport: HttpTransport) {}
  notifications(
    watches: PluginAppResourceWatch[],
    signal: AbortSignal,
  ): AsyncIterable<PluginAppResourceNotice> {
    return streamServerSentEvents(
      async () => {
        const response = await this.transport.requestResponse(
          "/sessions/plugin-app-notifications/stream",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ watches }),
            signal,
          },
        );
        if (!response.body)
          throw new Error("plugin_app_notification_stream_unavailable");
        return response.body;
      },
      (value) => {
        if (
          !value ||
          typeof value !== "object" ||
          !("runtimeEpoch" in value) ||
          typeof value.runtimeEpoch !== "string" ||
          !("kind" in value)
        )
          throw new Error("plugin_app_notification_invalid");
        if (value.kind === "resync")
          return { kind: "resync", runtimeEpoch: value.runtimeEpoch };
        if (
          value.kind === "resource-updated" &&
          "appId" in value &&
          typeof value.appId === "string" &&
          "leaseGeneration" in value &&
          typeof value.leaseGeneration === "number" &&
          Number.isSafeInteger(value.leaseGeneration) &&
          "uri" in value &&
          typeof value.uri === "string"
        )
          return {
            kind: "resource-updated",
            runtimeEpoch: value.runtimeEpoch,
            appId: value.appId,
            leaseGeneration: value.leaseGeneration,
            uri: value.uri,
          };
        throw new Error("plugin_app_notification_invalid");
      },
    );
  }
  list(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginAppListResponse> {
    return this.transport.request(
      `/sessions/${encodeURIComponent(sessionId)}/plugin-apps`,
      options,
    );
  }
  catalog(
    sessionId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{
    backends: Array<{
      pluginId: string;
      pluginVersion: string;
      pluginDigest: string;
      definitionDigest: string;
      backendId: string;
      backendKind: PluginAppRecord["backendKind"];
      surfaces: import("@vykor/protocol").PluginAppSurfaceDefinition[];
    }>;
  }> {
    return this.transport.request(
      `/sessions/${encodeURIComponent(sessionId)}/plugin-apps/catalog`,
      options,
    );
  }
  open(
    sessionId: string,
    input: OpenPluginAppInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginAppResponse & { openedByRequest: boolean }> {
    return this.transport.request(
      `/sessions/${encodeURIComponent(sessionId)}/plugin-apps/open`,
      { ...options, method: "POST", body: parseOpenPluginAppInput(input) },
    );
  }
  prepare(
    source: PluginAppSource,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginAppResponse> {
    return this.transport.request(path(source) + "/prepare", {
      ...options,
      method: "POST",
    });
  }
  openToolResult(
    sessionId: string,
    sourcePartId: string,
  ): Promise<PluginAppResponse> {
    return this.transport.request(
      `/sessions/${encodeURIComponent(sessionId)}/plugin-apps/open-tool-result`,
      { method: "POST", body: { sourcePartId } },
    );
  }
  initialResult(
    source: PluginAppSource,
    lease: PluginAppRuntimeLease,
    sourcePartId: string,
  ): Promise<{
    arguments: Record<string, unknown>;
    result: import("@vykor/protocol").McpCallResultData;
    dataError?: string;
  }> {
    return this.transport.request(path(source) + "/initial-result", {
      method: "POST",
      body: { lease, sourcePartId },
    });
  }
  close(
    source: PluginAppSource,
    input: ClosePluginAppInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ app: PluginAppRecord }> {
    return this.transport.request(path(source) + "/close", {
      ...options,
      method: "POST",
      body: parseClosePluginAppInput(input),
    });
  }
  async invoke(
    input: PluginAppToolRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginAppActionResponse> {
    const body = parsePluginAppToolRequest(input);
    const response = await this.transport.request<PluginAppActionResponse>(
      path(body.source) + "/actions",
      { ...options, method: "POST", body },
    );
    this.checkReceipt(
      response.receipt,
      body.source,
      body.requestId,
      body.expectedRevision,
    );
    return response;
  }
  async getAction(
    source: PluginAppSource,
    requestId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginAppActionResponse> {
    const result = await this.transport.request<PluginAppActionResponse>(
      path(source) + `/actions/${encodeURIComponent(requestId)}`,
      options,
    );
    this.checkReceipt(result.receipt, source, requestId);
    return result;
  }
  async cancelAction(
    source: PluginAppSource,
    requestId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginAppActionResponse> {
    const result = await this.transport.request<PluginAppActionResponse>(
      path(source) + `/actions/${encodeURIComponent(requestId)}/cancel`,
      { ...options, method: "POST" },
    );
    this.checkReceipt(result.receipt, source, requestId);
    return result;
  }
  readResource(
    source: PluginAppSource,
    lease: PluginAppRuntimeLease | undefined,
    uri: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ contents: unknown[] }> {
    return this.transport.request(path(source) + "/resources/read", {
      ...options,
      method: "POST",
      body: { ...(lease ? { lease: { ...lease } } : {}), uri },
    });
  }
  listResources(
    source: PluginAppSource,
    lease: PluginAppRuntimeLease | undefined,
    cursor?: string,
  ): Promise<{ resources: unknown[]; nextCursor?: string }> {
    return this.transport.request(path(source) + "/resources/list", {
      method: "POST",
      body: {
        ...(lease ? { lease: { ...lease } } : {}),
        ...(cursor ? { cursor } : {}),
      },
    });
  }
  listResourceTemplates(
    source: PluginAppSource,
    lease: PluginAppRuntimeLease | undefined,
    cursor?: string,
  ): Promise<{ resourceTemplates: unknown[]; nextCursor?: string }> {
    return this.transport.request(path(source) + "/resource-templates/list", {
      method: "POST",
      body: {
        ...(lease ? { lease: { ...lease } } : {}),
        ...(cursor ? { cursor } : {}),
      },
    });
  }
  async submitConversation(
    input: PluginAppConversationRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginAppSubmissionReceipt> {
    const body = parsePluginAppConversationRequest(input);
    const result = await this.transport.request<{
      receipt: PluginAppSubmissionReceipt;
    }>(path(body.source) + "/conversation/submissions", {
      ...options,
      method: "POST",
      body,
    });
    this.checkReceipt(
      result.receipt,
      body.source,
      body.requestId,
      body.expectedRevision,
    );
    return result.receipt;
  }
  async getConversationSubmission(
    source: PluginAppSource,
    requestId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginAppSubmissionReceipt> {
    const result = await this.transport.request<{
      receipt: PluginAppSubmissionReceipt;
    }>(
      path(source) +
        `/conversation/submissions/${encodeURIComponent(requestId)}`,
      options,
    );
    this.checkReceipt(result.receipt, source, requestId);
    return result.receipt;
  }
  private checkReceipt(
    receipt: PluginAppActionResponse["receipt"] | PluginAppSubmissionReceipt,
    source: PluginAppSource,
    requestId: string,
    revision?: number,
  ) {
    if (
      !receipt ||
      receipt.source?.sessionId !== source.sessionId ||
      receipt.source.appId !== source.appId ||
      receipt.requestId !== requestId ||
      typeof receipt.runId !== "string" ||
      !receipt.runId ||
      !Number.isSafeInteger(receipt.expectedRevision) ||
      receipt.expectedRevision < 0 ||
      (revision !== undefined && receipt.expectedRevision !== revision) ||
      ("acceptedRevision" in receipt &&
        (receipt.acceptedRevision !== receipt.expectedRevision + 1 ||
          !["not_started", "completed", "unknown"].includes(
            receipt.executionState,
          ))) ||
      ("inputId" in receipt &&
        (typeof receipt.inputId !== "string" || !receipt.inputId))
    )
      throw new Error("plugin_app_receipt_mismatch");
  }
}
