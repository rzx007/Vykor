import type { HttpTransport } from "@rzx/client";
import type { PluginInfo, ReloadPluginsResponse } from "@vykor/protocol";

export class PluginResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /plugins?cwd=` */
  async list(options: { cwd: string; signal?: AbortSignal }): Promise<{
    plugins: PluginInfo[];
    warnings: string[];
  }> {
    const { signal, ...query } = options;
    return await this.transport.request<{ plugins: PluginInfo[]; warnings: string[] }>(
      this.transport.path("/plugins", query),
      { signal },
    );
  }

  /** `POST /plugins/:id/enable` */
  async enable(
    id: string,
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.transport.request<{ message: string }>(
      `/plugins/${encodeURIComponent(id)}/enable`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** `POST /plugins/:id/disable` */
  async disable(
    id: string,
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.transport.request<{ message: string }>(
      `/plugins/${encodeURIComponent(id)}/disable`,
      { method: "POST", body: input, signal: options.signal },
    );
  }

  /** `POST /plugins/install-local` 或 `/plugins/link-local` */
  async installLocal(input: {
    cwd: string;
    sourcePath: string;
    scope: "user";
    approvedPermissions: string[];
    link?: boolean;
  }): Promise<{ message: string }> {
    return await this.transport.request<{ message: string }>(
      input.link ? "/plugins/link-local" : "/plugins/install-local",
      { method: "POST", body: input },
    );
  }

  /** `DELETE /plugins/:id` */
  async uninstall(
    id: string,
    input: { cwd: string },
  ): Promise<{ message: string }> {
    return await this.transport.request<{ message: string }>(
      `/plugins/${encodeURIComponent(id)}`,
      { method: "DELETE", body: input },
    );
  }

  /** `POST /plugins/reload` */
  async reload(
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<ReloadPluginsResponse> {
    return await this.transport.request<ReloadPluginsResponse>(
      "/plugins/reload",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
  }
}
