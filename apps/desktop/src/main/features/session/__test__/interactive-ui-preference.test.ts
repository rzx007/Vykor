import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { expect, it, vi } from "vitest"
import type { VykorClient } from "@rzx/client"
import { IpcChannels } from "@shared/ipc-channels"
import { settingsIpcContribution } from "../../settings/ipc"
import { getDesktopPreferences } from "../../settings/desktop-preferences"
import { sessionIpcContribution } from "../ipc"
import { desktopSessionService } from "../session-service"

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn() }))
vi.mock("electron", () => ({ app: { getPath }, BrowserWindow: { getAllWindows: () => [] } }))

it("persists the local switch and captures its value when each message is sent", async () => {
  const userData = join(process.env.VYKOR_CONFIG_DIR!, "user-data")
  mkdirSync(userData)
  getPath.mockReturnValue(userData)
  const sent: Array<Record<string, unknown>> = []
  const admission: Pick<VykorClient["sessions"], "admitPrompt"> = {
    admitPrompt: async (_session, input) => {
      sent.push(input.metadata ?? {})
      return {} as Awaited<ReturnType<VykorClient["sessions"]["admitPrompt"]>>
    },
  }
  const connection = Promise.withResolvers<VykorClient>()
  const agentClient = vi.spyOn(desktopSessionService, "agentClient").mockReturnValue(connection.promise)
  const handlers = [...sessionIpcContribution.register({} as never), ...settingsIpcContribution.register({} as never)]
  const invoke = (channel: typeof IpcChannels[keyof typeof IpcChannels], ...args: unknown[]) =>
    handlers.find((entry) => entry.channel === channel)!.handler({} as never, ...args)
  const send = (id: string) => invoke(IpcChannels.sessionSendPrompt, {
    id, sessionId: "session", items: [{ type: "text", text: "做成可筛选的表格" }], attachments: [],
    ...(invoke(IpcChannels.settingsGetInteractiveUiEnabled) === true ? { interactiveUiEnabled: true } : {}),
  })

  try {
    expect(invoke(IpcChannels.settingsGetInteractiveUiEnabled)).toBe(false)
    expect(invoke(IpcChannels.settingsUpdateInteractiveUiEnabled, true)).toBe(true)
    expect(getDesktopPreferences()).toMatchObject({ interactiveUiEnabled: true })
    const first = send("queued")
    expect(invoke(IpcChannels.settingsUpdateInteractiveUiEnabled, false)).toBe(false)
    connection.resolve({ sessions: admission } as VykorClient)
    await first
    await send("ordinary")
    expect(sent[0]?.replyPresentation).toBe("vykor-ui-v1")
    expect(sent[1]).not.toHaveProperty("replyPresentation")
  } finally {
    agentClient.mockRestore()
  }
})
