import { classifyRecoverySessions } from "./legacy-composer"
import { app } from "electron"
import { BusinessDataChannels, type BusinessDataKey } from "../../../shared/business-data-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopSessionService } from "../session/session-service"
import { desktopBusinessDataService } from "./business-data-service"
import { acknowledgeBusinessDataFlush, markBusinessDataWindowReady } from "./window-flush"
export const businessDataIpcContribution: IpcContribution = {
  id: "business-data",
  register: () => [
    {
      channel: BusinessDataChannels.recordDesktopScan,
      handler: (_event, sources) => desktopBusinessDataService.recordDesktopScan(sources as Record<string, string>, {
        userDataDir: app.getPath("userData"), documentsDir: app.getPath("documents"),
      }),
    },
    {
      channel: BusinessDataChannels.consumerReady,
      handler: (event) => markBusinessDataWindowReady(event.sender.id),
    },
    {
      channel: BusinessDataChannels.read,
      handler: (_event, key) => desktopBusinessDataService.read(key as BusinessDataKey),
    },
    {
      channel: BusinessDataChannels.write,
      handler: (_event, key, value, revision) =>
        desktopBusinessDataService.write(key as BusinessDataKey, value, revision as number | null),
    },
    {
      channel: BusinessDataChannels.importLegacy,
      handler: (_event, key, value, digest, unresolved) =>
        desktopBusinessDataService.importLegacy(
          key as BusinessDataKey,
          value,
          digest as string,
          unresolved as string[] | undefined
        ),
    },
    {
      channel: BusinessDataChannels.acknowledgeUnresolved,
      handler: (_event, digest) =>
        desktopBusinessDataService.acknowledgeUnresolvedComposer(digest as string),
    },
    { channel: BusinessDataChannels.flush, handler: () => desktopBusinessDataService.flush() },
    {
      channel: BusinessDataChannels.flushAck,
      handler: (event, requestId, success) =>
        acknowledgeBusinessDataFlush(event.sender.id, requestId, success),
    },
    {
      channel: BusinessDataChannels.classifySessions,
      handler: async (_event, ids) => {
        const client = await desktopSessionService.daemonClient()
        return classifyRecoverySessions(ids, (id) => client.sessions.get(id))
      },
    },
  ],
}
