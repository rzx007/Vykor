import type { Settings } from "@vykor/host-config";
import type { UsageSnapshot } from "@vykor/agent-contracts";

export interface AppState {
  sessionId: string;
  createdAt: Date;
  model: string;
  settings: Settings;
  totalUsage: UsageSnapshot;
}

export class AppStateStore {
  private state: AppState;

  constructor(settings: Settings) {
    this.state = {
      sessionId: crypto.randomUUID(),
      createdAt: new Date(),
      model: settings.model,
      settings,
      totalUsage: {
        inputTokens: 0,
        outputTokens: 0,
      },
    };
  }

  get(): AppState {
    return { ...this.state };
  }

  addUsage(usage: UsageSnapshot): void {
    this.state.totalUsage = {
      inputTokens: this.state.totalUsage.inputTokens + usage.inputTokens,
      outputTokens: this.state.totalUsage.outputTokens + usage.outputTokens,
      cacheCreationTokens:
        (this.state.totalUsage.cacheCreationTokens ?? 0) +
        (usage.cacheCreationTokens ?? 0),
      cacheReadTokens:
        (this.state.totalUsage.cacheReadTokens ?? 0) +
        (usage.cacheReadTokens ?? 0),
      costUsd:
        (this.state.totalUsage.costUsd ?? 0) + (usage.costUsd ?? 0),
    };
  }
}
