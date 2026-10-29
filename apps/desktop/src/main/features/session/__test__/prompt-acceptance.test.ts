import { describe, expect, it, vi } from "vitest"
import { DesktopSessionService } from "../session-service"
import { DaemonConnectionService } from "../daemon-connection-service"

describe("prompt acceptance recovery read", () => {
  it.each([true, false])(
    "reads durable input identity without admission or changing subscriptions (accepted=%s)",
    async (accepted) => {
      const getState = vi.fn().mockResolvedValue({ inputs: accepted ? [{ id: "original" }] : [] })
      const admitPrompt = vi.fn()
      const connection = new DaemonConnectionService()
      vi.spyOn(connection, "getClient").mockResolvedValue({
        sessions: { getState, admitPrompt },
      } as never)
      const service = new DesktopSessionService(connection)
      expect(await service.checkPromptAccepted({ sessionId: "s", inputId: "original" })).toBe(
        accepted
      )
      expect(getState).toHaveBeenCalledExactlyOnceWith("s")
      expect(admitPrompt).not.toHaveBeenCalled()
    }
  )

  it("propagates read failures instead of treating them as not accepted", async () => {
    const connection = new DaemonConnectionService()
    vi.spyOn(connection, "getClient").mockResolvedValue({
      sessions: { getState: vi.fn().mockRejectedValue(new Error("offline")) },
    } as never)
    await expect(
      new DesktopSessionService(connection).checkPromptAccepted({
        sessionId: "s",
        inputId: "original",
      })
    ).rejects.toThrow("offline")
  })
})
