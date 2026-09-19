import { describe, expect, it, vi } from "vitest";

import type { HttpTransport } from "../transport/http-transport.js";
import { ChannelResource } from "./channel-resource.js";

function makeResource() {
  const calls: Array<{ path: string; options: Record<string, unknown> }> = [];
  const transport = {
    request: vi.fn(async (path: string, options: Record<string, unknown> = {}) => {
      calls.push({ path, options });
      return { ok: true };
    }),
    path: (pathname: string) => pathname,
  };
  return {
    resource: new ChannelResource(transport as unknown as HttpTransport),
    calls,
  };
}

describe("ChannelResource runtime and onboarding methods", () => {
  it("calls the runtime status endpoint", async () => {
    const { resource, calls } = makeResource();
    await resource.runtimeStatus();
    expect(calls[0]).toMatchObject({ path: "/channels/runtime/status", options: {} });
  });

  it("posts start and stop control bodies", async () => {
    const { resource, calls } = makeResource();
    await resource.startRuntime({ connector: "feishu" });
    await resource.stopRuntime();
    expect(calls[0]).toMatchObject({
      path: "/channels/runtime/start",
      options: { method: "POST", body: { connector: "feishu" } },
    });
    expect(calls[1]).toMatchObject({ path: "/channels/runtime/stop", options: { method: "POST" } });
  });

  it("reads and patches the feishu config", async () => {
    const { resource, calls } = makeResource();
    await resource.getFeishu();
    await resource.patchFeishu({ enabled: false, sendProgress: false });
    expect(calls[0]?.path).toBe("/channels/feishu");
    expect(calls[1]).toMatchObject({
      path: "/channels/feishu",
      options: { method: "PATCH", body: { enabled: false, sendProgress: false } },
    });
  });

  it("connects manually and removes the channel", async () => {
    const { resource, calls } = makeResource();
    await resource.connectFeishu({ appId: "cli_x", appSecret: "sec" });
    await resource.removeFeishu();
    expect(calls[0]).toMatchObject({
      path: "/channels/feishu/connect",
      options: { method: "POST", body: { appId: "cli_x", appSecret: "sec" } },
    });
    expect(calls[1]).toMatchObject({ path: "/channels/feishu", options: { method: "DELETE" } });
  });

  it("adds and removes allowlist entries, encoding the key", async () => {
    const { resource, calls } = makeResource();
    await resource.addFeishuAllow({ id: "ou_1", name: "Alice" });
    await resource.removeFeishuAllow("Alice/Work");
    expect(calls[0]).toMatchObject({
      path: "/channels/feishu/allow",
      options: { method: "POST", body: { id: "ou_1", name: "Alice" } },
    });
    expect(calls[1]).toMatchObject({
      path: "/channels/feishu/allow/Alice%2FWork",
      options: { method: "DELETE" },
    });
  });

  it("drives the registration endpoints", async () => {
    const { resource, calls } = makeResource();
    await resource.startFeishuRegistration({ domain: "lark" });
    await resource.feishuRegistrationStatus();
    await resource.cancelFeishuRegistration();
    expect(calls[0]).toMatchObject({
      path: "/channels/feishu/registration",
      options: { method: "POST", body: { domain: "lark" } },
    });
    expect(calls[1]?.options).toMatchObject({});
    expect(calls[2]).toMatchObject({
      path: "/channels/feishu/registration",
      options: { method: "DELETE" },
    });
  });
});
