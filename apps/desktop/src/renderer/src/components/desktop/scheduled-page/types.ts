export type ScheduledFilter = "all" | "active" | "paused" | "completed"

export type ScheduledPageProps = {
  onStartConversation: () => void
  onOpenConversation: (sessionId: string) => Promise<void>
  onSessionListChanged: () => Promise<void>
}

export const scheduledFilters: ScheduledFilter[] = ["all", "active", "paused", "completed"]
