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

  async prepareRestartWithTemporaryChatProtection(signal: AbortSignal): Promise<{ prepared: true }> {
    return this.transport.request<{ prepared: true }>("/maintenance/prepare-root-migration", { method: "POST", signal });
  }

  async isPreparedRestartComplete(pid: number, signal: AbortSignal): Promise<boolean> {
    const health = await this.transport.request<{ restartPrepared?: boolean }>("/health", { signal });
    if (!health.restartPrepared) return false;
    const state = await this.transport.request<{ phase: string }>("/maintenance/readiness", { signal });
    if (state.phase !== "closed") return false;
    const identity = await this.transport.request<{ pid: number }>("/debug/process", { signal });
    return identity.pid === pid;
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
