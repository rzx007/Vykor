import type { UsageSnapshot, ICostTracker } from "../index";

export class CostTracker implements ICostTracker {
  private total: UsageSnapshot = {
    inputTokens: 0,
    outputTokens: 0,
  };
  private incomplete = false;

  addUsage(usage: UsageSnapshot): void {
    if (usage.usageIncomplete) this.incomplete = true;
    this.total = {
      inputTokens: this.total.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: this.total.outputTokens + (usage.outputTokens ?? 0),
      cacheCreationTokens:
        (this.total.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0) || undefined,
      cacheReadTokens:
        (this.total.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0) || undefined,
    };
  }

  markUsageIncomplete(): void {
    this.incomplete = true;
  }

  getTotal(): UsageSnapshot {
    return this.incomplete
      ? { ...this.total, usageIncomplete: true }
      : { ...this.total };
  }

  reset(): void {
    this.total = { inputTokens: 0, outputTokens: 0 };
    this.incomplete = false;
  }
}
