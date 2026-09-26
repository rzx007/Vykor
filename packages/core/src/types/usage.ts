export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  /**
   * 数字只是「已知小计」，部分请求的用量未知或因失败丢失。
   * 未知请求不能被填成 0，也不能因为后续成功而清除该标记。
   */
  usageIncomplete?: boolean;
}

export interface CostTracker {
  addUsage(usage: UsageSnapshot): void;
  getTotal(): UsageSnapshot;
  reset(): void;
  /**
   * 标记当前统计周期内存在用量未知/不完整的尝试。标记一旦置位，
   * 后续已知用量只能累加不能清除，只有 reset() 能恢复初值。
   */
  markUsageIncomplete(): void;
}
