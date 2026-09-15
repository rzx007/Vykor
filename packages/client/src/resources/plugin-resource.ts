/**
 * PluginResource: 插件发现、生命周期、本地与归档安装、Git 安装与重载资源。
 */

import type { HttpTransport } from "../transport/http-transport.js";
import type {
  PluginArchivePreview,
  PluginGitPreview,
  PluginInfo,
  ReloadPluginsResponse,
} from "../types/index.js";

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

  /** `POST /plugins/archive/preview` */
  async previewArchive(
    input: { cwd: string; archivePath: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginArchivePreview> {
    return await this.transport.request<PluginArchivePreview>(
      "/plugins/archive/preview",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
  }

  /** `POST /plugins/archive/install` */
  async installArchive(
    input: {
      cwd: string;
      archivePath: string;
      expectedArchiveDigest: string;
      approvedPermissions: string[];
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.transport.request<{ message: string }>(
      "/plugins/archive/install",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
  }

  /** `POST /plugins/git/preview` */
  async previewGit(
    input: { cwd: string; url: string; ref?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginGitPreview> {
    return await this.transport.request<PluginGitPreview>(
      "/plugins/git/preview",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
  }

  /** `POST /plugins/git/install` */
  async installGit(
    input: {
      cwd: string;
      url: string;
      ref?: string;
      expectedSourceDigest: string;
      approvedPermissions: string[];
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.transport.request<{ message: string }>(
      "/plugins/git/install",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
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
