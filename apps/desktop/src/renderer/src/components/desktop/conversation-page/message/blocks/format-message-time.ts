import { format, isSameDay, isSameWeek } from "date-fns"
import { zhCN } from "date-fns/locale"

export function formatMessageTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const current = new Date(now)
  const clock = format(date, "HH:mm")

  if (isSameDay(date, current)) return clock
  if (isSameWeek(date, current, { weekStartsOn: 1 })) {
    return `${format(date, "EEEE", { locale: zhCN })} ${clock}`
  }
  return `${format(date, "MM'月'dd")} ${clock}`
}
