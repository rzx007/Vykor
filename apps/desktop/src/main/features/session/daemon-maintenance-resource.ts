import type { HttpTransport } from "@rzx/client";

export interface DaemonRestartPreview {
  runs: Array<{ id: string; sessionId: string; status: string }>
  tasks: Array<{ id: string; sessionId: string; status: string }>
  terminals: Array<{ id: string; status: string }>
}

export class DaemonMaintenanceResource {
  constructor(private readonly transport: HttpTransport) {}

  async getRestartPreview(options: { signal?: AbortSignal } = {}): Promise<DaemonRestartPreview> {
    return this.transport.request<DaemonRestartPreview>("/maintenance/restart-preview", { signal: options.signal });
  }

  async prepareRestart(options: { signal?: AbortSignal } = {}): Promise<{ prepared: true }> {
    return this.transport.request<{ prepared: true }>("/maintenance/prepare-restart", { method: "POST", signal: options.signal });
  }

  async requestDataSwitch(
    target: { id: string; directory: string; storePath: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ id: string }> {
    return this.transport.request("/maintenance/data-switch", { method: "POST", body: target, signal: options.signal });
  }

  async getDataSwitchResult(id: string): Promise<{ status: "pending" | "succeeded" | "failed" | "interrupted" | "rollback_failed"; error?: string; rollbackError?: string }> {
    return this.transport.request(`/maintenance/data-switch/${encodeURIComponent(id)}`);
  }

}
