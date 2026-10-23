import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  client: [] as unknown[],
  ws: [] as unknown[],
}));

vi.mock("@larksuiteoapi/node-sdk", () => {
  class Client {
    constructor(options: unknown) {
      captured.client.push(options);
    }
  }
  class WSClient {
    constructor(options: unknown) {
      captured.ws.push(options);
    }
    async start(): Promise<void> {}
    async close(): Promise<void> {}
  }
  class EventDispatcher {
    register(): this {
      return this;
    }
  }
  return {
    Client,
    WSClient,
    EventDispatcher,
    LoggerLevel: { info: 2 },
    Domain: { Feishu: 0, Lark: 1 },
  };
});

import { FeishuAdapter } from "../feishu.js";

describe("FeishuAdapter.connect domain", () => {
  it("passes the Lark domain enum to Client and WSClient", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s", domain: "lark" });
    await adapter.connect();
    expect(captured.client[0]).toMatchObject({ domain: 1 });
    expect(captured.ws[0]).toMatchObject({ domain: 1 });
    await adapter.disconnect();
  });

  it("defaults to the Feishu domain enum", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    await adapter.connect();
    expect(captured.client[1]).toMatchObject({ domain: 0 });
    expect(captured.ws[1]).toMatchObject({ domain: 0 });
    await adapter.disconnect();
  });
});
