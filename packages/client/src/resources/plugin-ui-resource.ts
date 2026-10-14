import {
  parseDismissPluginUiInput,
  parseInvokePluginUiActionInput,
  type DismissPluginUiInput,
  type InvokePluginUiActionInput,
  type PluginUiActionReceipt,
  type PluginUiActionResponse,
  type PluginUiDocumentResponse,
  type PluginUiInstanceRecord,
  type PluginUiInstanceResponse,
  parsePluginUiConversationRequest,
  parseSubmitPluginUiConversationInput,
  parsePluginUiConversationPrepared,
  parsePluginUiConversationReceipt,
  ProtocolValidationError,
  type PluginUiConversationRequest,
  type PluginUiConversationPrepared,
  type SubmitPluginUiConversationInput,
  type PluginUiConversationReceipt,
} from "@vykor/protocol";
import type { HttpTransport } from "../transport/http-transport.js";

function path(sessionId: string, instanceId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/plugin-ui/${encodeURIComponent(instanceId)}`;
}

export class PluginUiResource {
  constructor(private readonly transport: HttpTransport) {}

  async get(
    sessionId: string,
    instanceId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginUiInstanceResponse> {
    const response = await this.transport.request<PluginUiInstanceResponse>(
      path(sessionId, instanceId),
      options,
    );
    if (
      !response.conversation ||
      typeof response.conversation.draft !== "boolean" ||
      typeof response.conversation.submit !== "boolean"
    )
      throw new ProtocolValidationError(
        "Plugin UI response requires conversation capability booleans",
        "conversation",
      );
    return response;
  }

  async prepareConversation(
    sessionId: string,
    instanceId: string,
    input: PluginUiConversationRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginUiConversationPrepared> {
    const body = parsePluginUiConversationRequest(input);
    const prepared = parsePluginUiConversationPrepared(
      await this.transport.request(
        path(sessionId, instanceId) + "/conversation/prepare",
        { ...options, method: "POST", body },
      ),
    );
    if (
      prepared.instanceId !== instanceId ||
      prepared.mode !== body.mode ||
      prepared.revision !== body.expectedRevision
    )
      throw new ProtocolValidationError(
        "Plugin UI prepared conversation differs from the request",
      );
    return prepared;
  }

  async submitConversation(
    sessionId: string,
    instanceId: string,
    input: SubmitPluginUiConversationInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<Extract<PluginUiConversationReceipt, { mode: "submit" }>> {
    const body = parseSubmitPluginUiConversationInput(input);
    const response = await this.transport.request<{ receipt: unknown }>(
      path(sessionId, instanceId) + "/conversation/submissions",
      { ...options, method: "POST", body },
    );
    const receipt = this.conversationReceipt(
      response.receipt,
      instanceId,
      body.requestId,
    );
    if (receipt.revision !== body.expectedRevision + 1)
      throw new ProtocolValidationError(
        "Plugin UI submission revision differs from the request",
      );
    return receipt;
  }

  async getConversationSubmission(
    sessionId: string,
    instanceId: string,
    requestId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<Extract<PluginUiConversationReceipt, { mode: "submit" }>> {
    const response = await this.transport.request<{ receipt: unknown }>(
      path(sessionId, instanceId) +
        `/conversation/submissions/${encodeURIComponent(requestId)}`,
      options,
    );
    return this.conversationReceipt(response.receipt, instanceId, requestId);
  }

  private conversationReceipt(
    value: unknown,
    instanceId: string,
    requestId: string,
  ): Extract<PluginUiConversationReceipt, { mode: "submit" }> {
    const receipt = parsePluginUiConversationReceipt(value);
    if (
      receipt.mode !== "submit" ||
      receipt.instanceId !== instanceId ||
      receipt.requestId !== requestId
    )
      throw new ProtocolValidationError(
        "Plugin UI submission receipt differs from the request",
      );
    return receipt;
  }

  getDocument(
    sessionId: string,
    instanceId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginUiDocumentResponse> {
    return this.transport.request(
      path(sessionId, instanceId) + "/document",
      options,
    );
  }

  async invokeAction(
    sessionId: string,
    instanceId: string,
    input: InvokePluginUiActionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginUiActionReceipt> {
    const body = structuredClone(parseInvokePluginUiActionInput(input));
    const response = await this.transport.request<{
      receipt: PluginUiActionReceipt;
    }>(path(sessionId, instanceId) + "/actions", {
      ...options,
      method: "POST",
      body,
    });
    return response.receipt;
  }

  getAction(
    sessionId: string,
    instanceId: string,
    requestId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginUiActionResponse> {
    return this.transport.request(
      path(sessionId, instanceId) + `/actions/${encodeURIComponent(requestId)}`,
      options,
    );
  }

  async dismiss(
    sessionId: string,
    instanceId: string,
    input: DismissPluginUiInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginUiInstanceRecord> {
    const body = parseDismissPluginUiInput(input);
    const response = await this.transport.request<{
      instance: PluginUiInstanceRecord;
    }>(path(sessionId, instanceId) + "/dismiss", {
      ...options,
      method: "POST",
      body,
    });
    return response.instance;
  }
}
