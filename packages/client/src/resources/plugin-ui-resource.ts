import { parseDismissPluginUiInput, parseInvokePluginUiActionInput,
  type DismissPluginUiInput, type InvokePluginUiActionInput, type PluginUiActionReceipt,
  type PluginUiActionResponse, type PluginUiDocumentResponse, type PluginUiInstanceRecord,
  type PluginUiInstanceResponse } from "@vykor/protocol";
import type { HttpTransport } from "../transport/http-transport.js";

function path(sessionId: string, instanceId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/plugin-ui/${encodeURIComponent(instanceId)}`;
}

export class PluginUiResource {
  constructor(private readonly transport: HttpTransport) {}

  get(sessionId: string, instanceId: string, options: { signal?: AbortSignal } = {}): Promise<PluginUiInstanceResponse> {
    return this.transport.request(path(sessionId, instanceId), options);
  }

  getDocument(sessionId: string, instanceId: string, options: { signal?: AbortSignal } = {}): Promise<PluginUiDocumentResponse> {
    return this.transport.request(path(sessionId, instanceId) + "/document", options);
  }

  async invokeAction(sessionId: string, instanceId: string, input: InvokePluginUiActionInput, options: { signal?: AbortSignal } = {}): Promise<PluginUiActionReceipt> {
    const body = structuredClone(parseInvokePluginUiActionInput(input));
    const response = await this.transport.request<{ receipt: PluginUiActionReceipt }>(path(sessionId, instanceId) + "/actions", { ...options, method: "POST", body });
    return response.receipt;
  }

  getAction(sessionId: string, instanceId: string, requestId: string, options: { signal?: AbortSignal } = {}): Promise<PluginUiActionResponse> {
    return this.transport.request(path(sessionId, instanceId) + `/actions/${encodeURIComponent(requestId)}`, options);
  }

  async dismiss(sessionId: string, instanceId: string, input: DismissPluginUiInput, options: { signal?: AbortSignal } = {}): Promise<PluginUiInstanceRecord> {
    const body = parseDismissPluginUiInput(input);
    const response = await this.transport.request<{ instance: PluginUiInstanceRecord }>(path(sessionId, instanceId) + "/dismiss", { ...options, method: "POST", body });
    return response.instance;
  }
}
