import { createHash, randomUUID } from "node:crypto"
import { IpcChannels } from "../../../shared/ipc-channels"
import { richUiContentSchema, type RichUiLoadResult } from "../../../shared/rich-ui-content"
import { assertMainRenderer } from "../../core/ipc/main-renderer"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopPluginAppDocuments } from "../plugin-apps/document-protocol"
import { desktopSettingsService } from "../settings/settings-service"
import { fetchRichImage } from "./image-fetch"
import { resolveVideoEmbed, videoPreviewHtml } from "./video"

// Reuse frame ownership and teardown. Rich previews cannot acquire MCP App operations.
const richUiConnection = {}

export const chatRichUiIpcContribution: IpcContribution = {
  id: "chat-rich-ui",
  register: (ctx) => [
    {
      channel: IpcChannels.richUiLoad,
      async handler(event, input): Promise<RichUiLoadResult> {
        assertMainRenderer(ctx, event)
        if (!desktopSettingsService.getRichUiEnabled()) return { kind: "disabled" }
        const parsed = richUiContentSchema.safeParse(input)
        if (!parsed.success) throw new Error("无法加载不符合格式的聊天内容。")
        const content = parsed.data
        if (content.kind === "image")
          return { kind: "image", src: await fetchRichImage(content.url) }

        let embed: URL | undefined
        let html: string
        if (content.kind === "video") {
          embed = await resolveVideoEmbed(content.url)
          html = videoPreviewHtml(embed)
        } else {
          html = content.html
        }
        const { mountId } = desktopPluginAppDocuments.register(
          {
            ownerId: event.sender.id,
            connection: richUiConnection,
            sessionId: null,
            appId: randomUUID(),
            html,
            sha256: createHash("sha256").update(html).digest("hex"),
          },
          embed?.origin
        )
        return { kind: "frame", mountId }
      },
    },
    {
      channel: IpcChannels.richUiRelease,
      handler(event, mountId) {
        assertMainRenderer(ctx, event)
        if (
          typeof mountId === "string" &&
          desktopPluginAppDocuments.owns(mountId, event.sender.id, richUiConnection)
        )
          desktopPluginAppDocuments.revoke(mountId)
      },
    },
  ],
}
