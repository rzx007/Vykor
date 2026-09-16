/**
 * ProviderResource: 模型提供商与 Catalog 配置资源。
 */

import type { HttpTransport } from "../transport/http-transport.js";
import type {
  ConnectCatalogProviderInput,
  CustomProviderInput,
  ModelProviderInfo,
  ProviderInfo,
} from "../types/index.js";

export class ProviderResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /providers` */
  async listProviders(
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo[]> {
    const response = await this.transport.request<{ providers: ProviderInfo[] }>(
      "/providers",
      { signal: options.signal },
    );
    return response.providers;
  }

  /** `POST /providers/custom` */
  async createCustomProvider(
    input: CustomProviderInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    const response = await this.transport.request<{ provider: ProviderInfo }>(
      "/providers/custom",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.provider;
  }

  /** `POST /providers/catalog/:id/connect` */
  async connectCatalogProvider(
    id: string,
    apiKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderInfo>;
  async connectCatalogProvider(
    id: string,
    input: ConnectCatalogProviderInput,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderInfo>;
  async connectCatalogProvider(
    id: string,
    apiKeyOrInput: string | ConnectCatalogProviderInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    const body: ConnectCatalogProviderInput =
      typeof apiKeyOrInput === "string"
        ? { apiKey: apiKeyOrInput }
        : apiKeyOrInput;
    const response = await this.transport.request<{ provider: ProviderInfo }>(
      `/providers/catalog/${encodeURIComponent(id)}/connect`,
      { method: "POST", body, signal: options.signal },
    );
    return response.provider;
  }

  /** `PATCH /providers/catalog/:id` */
  async updateCatalogProviderHeaders(
    id: string,
    headers: Record<string, string>,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    const response = await this.transport.request<{ provider: ProviderInfo }>(
      `/providers/catalog/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: { headers },
        signal: options.signal,
      },
    );
    return response.provider;
  }

  /** `DELETE /providers/catalog/:id/connect` */
  async disconnectCatalogProvider(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.transport.request<{ ok: true }>(
      `/providers/catalog/${encodeURIComponent(id)}/connect`,
      { method: "DELETE", signal: options.signal },
    );
  }

  /** `PATCH /providers/custom/:id` */
  async updateCustomProvider(
    id: string,
    input: CustomProviderInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<ProviderInfo> {
    const response = await this.transport.request<{ provider: ProviderInfo }>(
      `/providers/custom/${encodeURIComponent(id)}`,
      { method: "PATCH", body: input, signal: options.signal },
    );
    return response.provider;
  }

  /** `DELETE /providers/custom/:id` */
  async removeCustomProvider(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.transport.request<{ ok: true }>(
      `/providers/custom/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
  }

  /** `GET /models` */
  async listModels(
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelProviderInfo[]> {
    const response = await this.transport.request<{ providers: ModelProviderInfo[] }>(
      "/models",
      { signal: options.signal },
    );
    return response.providers;
  }
}
