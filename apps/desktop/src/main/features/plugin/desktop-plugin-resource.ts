import type { MarketplaceCatalog, MarketplaceSourcesResponse, MarketplacePreviewRequest, MarketplacePreview, MarketplaceInstallRequest,
  MarketplaceOperation, MarketplaceCatalogRequest, MarketplaceAddSourceRequest, MarketplaceSourceEnabledRequest,
  MarketplaceCancelRequest, MarketplaceCancelResponse } from "@vykor/protocol";
import type { HttpTransport } from "@rzx/client";
import { PluginResource, type PluginInfo } from "@vykor/daemon-admin/plugins";

export interface PluginArchivePreview {
  archiveDigest: string;
  identity: { id: string; name: string; version: string; displayName?: string };
  requestedPermissions: string[];
  approvalRequired: boolean;
  replacementRequired?: boolean;
  inventory: Record<string, number>;
  diagnostics: PluginInfo["diagnostics"];
}

export interface PluginGitPreview {
  sourceDigest: string;
  url: string;
  ref?: string;
  commit: string;
  identity: { id: string; name: string; version: string; displayName?: string };
  requestedPermissions: string[];
  approvalRequired: boolean;
  replacementRequired?: boolean;
  inventory: Record<string, number>;
  diagnostics: PluginInfo["diagnostics"];
}

export class DesktopPluginResource extends PluginResource {
  constructor(private readonly desktopTransport: HttpTransport) { super(desktopTransport); }

  async marketplaceCatalog(options: MarketplaceCatalogRequest & { signal?: AbortSignal }): Promise<MarketplaceCatalog> {
    const { signal, ...query } = options;
    return this.desktopTransport.request(this.desktopTransport.path("/plugins/marketplace/catalog", query), { signal });
  }
  async marketplaceSources(options: { signal?: AbortSignal } = {}): Promise<MarketplaceSourcesResponse> {
    return this.desktopTransport.request("/plugins/marketplace/sources", { method: "GET", ...options });
  }
  async marketplaceAddSource(input: MarketplaceAddSourceRequest, options: { signal?: AbortSignal } = {}): Promise<MarketplaceSourcesResponse> {
    return this.desktopTransport.request("/plugins/marketplace/sources", { method: "POST", body: input, ...options });
  }
  async marketplacePreview(input: MarketplacePreviewRequest, options: { signal?: AbortSignal } = {}): Promise<MarketplacePreview> {
    return this.desktopTransport.request("/plugins/marketplace/preview", { method: "POST", body: input, ...options });
  }
  async marketplaceCancel(input: MarketplaceCancelRequest, options: { signal?: AbortSignal } = {}): Promise<MarketplaceCancelResponse> {
    return this.desktopTransport.request("/plugins/marketplace/cancel", { method: "POST", body: input, ...options });
  }
  async marketplaceInstall(input: MarketplaceInstallRequest, options: { signal?: AbortSignal } = {}): Promise<MarketplaceOperation> {
    return this.desktopTransport.request("/plugins/marketplace/install", { method: "POST", body: input, ...options });
  }
  async marketplaceSetSourceEnabled(sourceId: string, input: MarketplaceSourceEnabledRequest, options: { signal?: AbortSignal } = {}): Promise<MarketplaceSourcesResponse> {
    return this.desktopTransport.request(`/plugins/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "PATCH", body: input, ...options });
  }
  async marketplaceRemoveSource(sourceId: string, options: { signal?: AbortSignal } = {}): Promise<MarketplaceSourcesResponse> {
    return this.desktopTransport.request(`/plugins/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE", ...options });
  }
  async marketplaceOperation(operationId: string, options: { signal?: AbortSignal } = {}): Promise<MarketplaceOperation> {
    return this.desktopTransport.request(`/plugins/marketplace/operations/${encodeURIComponent(operationId)}`, options);
  }
  /** `POST /plugins/archive/preview` */
  async previewArchive(
    input: { cwd: string; archivePath: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<PluginArchivePreview> {
    return await this.desktopTransport.request<PluginArchivePreview>(
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
      allowSourceChange?: boolean;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.desktopTransport.request<{ message: string }>(
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
    return await this.desktopTransport.request<PluginGitPreview>(
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
      allowSourceChange?: boolean;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.desktopTransport.request<{ message: string }>(
      "/plugins/git/install",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
  }
}

export interface DesktopPluginClient {
  plugins: DesktopPluginResource;
}
