import { z } from "zod"
export async function classifyRecoverySessions(
  ids: unknown,
  get: (id: string) => Promise<{ storage?: string } | null | undefined>
): Promise<Record<string, "persistent" | "memory" | "unknown">> {
  const parsed = z.array(z.string().min(1).max(256)).max(500).safeParse(ids)
  if (!parsed.success) throw new Error("business-data composer classify INVALID_IDS")
  const result: Record<string, "persistent" | "memory" | "unknown"> = Object.create(null)
  for (const id of new Set(parsed.data)) {
    try {
      const session = await get(id)
      result[id] = !session ? "unknown" : session.storage === "memory" ? "memory" : "persistent"
    } catch (error) {
      if ((error as { status?: number } | null)?.status === 404) result[id] = "unknown"
      else throw new Error("business-data composer classify LOOKUP_FAILED")
    }
  }
  return result
}
