import { describe, expect, it } from "vitest"

import { channelConnectorLabel, isChannelSessionMetadata } from "./channel-types"

describe("isChannelSessionMetadata", () => {
  it("detects channel sessions by externalConversation or source", () => {
    expect(isChannelSessionMetadata({ externalConversation: { connector: "feishu" } })).toBe(true)
    expect(isChannelSessionMetadata({ source: "channel" })).toBe(true)
  })

  it("rejects ordinary sessions and forks of channel sessions", () => {
    expect(isChannelSessionMetadata({})).toBe(false)
    expect(
      isChannelSessionMetadata({
        source: "channel",
        externalConversation: { connector: "feishu" },
        fork: { sourceSessionId: "s1" },
      })
    ).toBe(false)
  })
})

describe("channelConnectorLabel", () => {
  it("maps known connectors and falls back otherwise", () => {
    expect(channelConnectorLabel("feishu")).toBe("飞书")
    expect(channelConnectorLabel("Lark")).toBe("飞书（国际）")
    expect(channelConnectorLabel("slack")).toBe("其他平台")
    expect(channelConnectorLabel(undefined)).toBe("其他平台")
  })
})
