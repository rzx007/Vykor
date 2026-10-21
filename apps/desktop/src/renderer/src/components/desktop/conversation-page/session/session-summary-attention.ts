export type SummaryAttentionItem = { key: string; startedAt?: number }

/** Per chat visit: progress and dismissal never reset an identity's notification. */
export class SessionSummaryAttention {
  private readonly seen: Set<string>
  constructor(
    private readonly enteredAt: number,
    initialKeys: string[] = []
  ) {
    this.seen = new Set(initialKeys)
  }
  observe(items: SummaryAttentionItem[]): boolean {
    let added = false
    for (const item of items) {
      if (this.seen.has(item.key)) continue
      this.seen.add(item.key)
      // Async job lists may arrive after mount; their original start time separates history.
      if (item.startedAt === undefined || item.startedAt >= this.enteredAt) added = true
    }
    return added
  }
}
