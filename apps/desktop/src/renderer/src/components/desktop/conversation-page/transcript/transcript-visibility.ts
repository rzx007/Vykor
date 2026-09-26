import type { DesktopSessionPart } from "@shared/session-types"
import { isSupersededModelPart } from "@vykor/client"

export function visibleTranscriptParts(
  parts: DesktopSessionPart[],
  showReasoning: boolean
): DesktopSessionPart[] {
  if (showReasoning && !parts.some((part) => part.type === "transformation" || isSupersededModelPart(part))) return parts

  return parts.filter(
    (part) => !isSupersededModelPart(part) && part.type !== "transformation" && (showReasoning || part.type !== "reasoning")
  )
}
