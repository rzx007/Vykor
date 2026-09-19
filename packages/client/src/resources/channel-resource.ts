import type {
  ChannelDeliveryRecord,
  ChannelRuntimeControlInput,
  ChannelRuntimeStatus,
  ChannelStatusSnapshot,
  DurableChannelMessageInput,
  DurableChannelMessageResult,
  FeishuAllowInput,
  FeishuChannelSnapshot,
  FeishuConnectInput,
  FeishuPatchInput,
  FeishuRegistrationSnapshot,
  FeishuRegistrationStartInput,
  RecordChannelDeliveryInput,
} from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";

export interface FeishuComposedSnapshot {
  feishu: FeishuChannelSnapshot;
  runtime: ChannelRuntimeStatus;
}

export class ChannelResource {
  constructor(private readonly transport: HttpTransport) {}

  async handleMessage(
    input: DurableChannelMessageInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<DurableChannelMessageResult> {
    return await this.transport.request<DurableChannelMessageResult>(
      "/channels/messages",
      { method: "POST", body: input, signal: options.signal },
    );
  }

  async recordDelivery(
    deliveryId: string,
    input: RecordChannelDeliveryInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChannelDeliveryRecord> {
    const response = await this.transport.request<{ delivery: ChannelDeliveryRecord }>(
      `/channels/deliveries/${encodeURIComponent(deliveryId)}/result`,
      { method: "POST", body: input, signal: options.signal },
    );
    return response.delivery;
  }

  async getStatus(
    options: { connector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChannelStatusSnapshot> {
    const { signal, ...query } = options;
    return await this.transport.request<ChannelStatusSnapshot>(
      this.transport.path("/channels/status", query),
      { signal },
    );
  }

  async listPendingDeliveries(
    options: { connector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChannelDeliveryRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{
      deliveries: ChannelDeliveryRecord[];
    }>(this.transport.path("/channels/deliveries/pending", query), { signal });
    return response.deliveries;
  }

  async runtimeStatus(options: { signal?: AbortSignal } = {}): Promise<ChannelRuntimeStatus> {
    return await this.transport.request<ChannelRuntimeStatus>("/channels/runtime/status", {
      signal: options.signal,
    });
  }

  async startRuntime(
    input: ChannelRuntimeControlInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<ChannelRuntimeStatus> {
    return await this.transport.request<ChannelRuntimeStatus>("/channels/runtime/start", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  async stopRuntime(
    input: ChannelRuntimeControlInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<ChannelRuntimeStatus> {
    return await this.transport.request<ChannelRuntimeStatus>("/channels/runtime/stop", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  async getFeishu(options: { signal?: AbortSignal } = {}): Promise<FeishuChannelSnapshot> {
    return await this.transport.request<FeishuChannelSnapshot>("/channels/feishu", {
      signal: options.signal,
    });
  }

  async patchFeishu(
    input: FeishuPatchInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<FeishuComposedSnapshot> {
    return await this.transport.request<FeishuComposedSnapshot>("/channels/feishu", {
      method: "PATCH",
      body: input,
      signal: options.signal,
    });
  }

  async connectFeishu(
    input: FeishuConnectInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<FeishuComposedSnapshot> {
    return await this.transport.request<FeishuComposedSnapshot>("/channels/feishu/connect", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  async removeFeishu(
    options: { signal?: AbortSignal } = {},
  ): Promise<FeishuComposedSnapshot> {
    return await this.transport.request<FeishuComposedSnapshot>("/channels/feishu", {
      method: "DELETE",
      signal: options.signal,
    });
  }

  async addFeishuAllow(
    input: FeishuAllowInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<FeishuChannelSnapshot> {
    return await this.transport.request<FeishuChannelSnapshot>("/channels/feishu/allow", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  async removeFeishuAllow(
    key: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<FeishuChannelSnapshot> {
    return await this.transport.request<FeishuChannelSnapshot>(
      `/channels/feishu/allow/${encodeURIComponent(key)}`,
      { method: "DELETE", signal: options.signal },
    );
  }

  async startFeishuRegistration(
    input: FeishuRegistrationStartInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<FeishuRegistrationSnapshot> {
    return await this.transport.request<FeishuRegistrationSnapshot>(
      "/channels/feishu/registration",
      { method: "POST", body: input, signal: options.signal },
    );
  }

  async feishuRegistrationStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<FeishuRegistrationSnapshot> {
    return await this.transport.request<FeishuRegistrationSnapshot>(
      "/channels/feishu/registration",
      { signal: options.signal },
    );
  }

  async cancelFeishuRegistration(
    options: { signal?: AbortSignal } = {},
  ): Promise<FeishuRegistrationSnapshot> {
    return await this.transport.request<FeishuRegistrationSnapshot>(
      "/channels/feishu/registration",
      { method: "DELETE", signal: options.signal },
    );
  }
}
