import { parsePluginUiConversationReceipt, ProtocolValidationError, type PluginUiActionResponse, type PluginUiConversationReceipt } from "@vykor/protocol";
import type { HttpTransport } from "@rzx/client";
function path(sessionId: string, instanceId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/plugin-ui/${encodeURIComponent(instanceId)}`;
}

export class PluginUiHistoryResource {
  constructor(private readonly transport: HttpTransport) {}
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
}
