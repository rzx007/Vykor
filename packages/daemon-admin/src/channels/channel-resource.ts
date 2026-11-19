import type { ChannelRuntimeControlInput, ChannelRuntimeStatus, ChannelStatusSnapshot, FeishuAllowInput, FeishuChannelSnapshot, FeishuConnectInput, FeishuPatchInput, FeishuRegistrationSnapshot, FeishuRegistrationStartInput } from "@vykor/protocol";
import type { HttpTransport } from "@rzx/client";

export interface FeishuComposedSnapshot {
  feishu: FeishuChannelSnapshot;
  runtime: ChannelRuntimeStatus;
}

export class ChannelResource {
  constructor(private readonly transport: HttpTransport) {}

  async getStatus(
    options: { connector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChannelStatusSnapshot> {
    const { signal, ...query } = options;
    return await this.transport.request<ChannelStatusSnapshot>(
      this.transport.path("/channels/status", query),
      { signal },
    );
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
