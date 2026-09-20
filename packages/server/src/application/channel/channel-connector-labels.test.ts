import { describe, expect, it } from "vitest";

import { channelConnectorLabel } from "./channel-connector-labels.js";

describe("channelConnectorLabel", () => {
  it("maps known connectors case-insensitively", () => {
    expect(channelConnectorLabel("feishu")).toBe("飞书");
    expect(channelConnectorLabel("Lark")).toBe("飞书（国际）");
  });

  it("falls back for unknown or empty connectors", () => {
    expect(channelConnectorLabel("slack")).toBe("其他平台");
    expect(channelConnectorLabel("  ")).toBe("其他平台");
  });
});
