import { describe, expect, it, vi } from "vitest";

import type { ChannelRuntimeStatus } from "@openharness/protocol";

import { ChannelRuntimeError, type ChannelRuntimeService } from "../../daemon/channel-runtime-service.js";
import {
  ChannelOnboardingError,
  type ChannelOnboardingService,
} from "../../application/channel/channel-onboarding-service.js";
import { createChannelControlRoutes } from "./channel-control.js";

const runtimeStatus: ChannelRuntimeStatus = {
  bootId: "boot-1",
  connectors: [{ connector: "feishu", enabled: true, state: "running" }],
  recentDenials: [],
};

function fakeRuntime(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    status: vi.fn(() => runtimeStatus),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ChannelRuntimeService;
}

function fakeOnboarding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    snapshot: vi.fn(async () => ({ configured: false, enabled: false, allowFrom: [] })),
    patch: vi.fn(async (input: { enabled?: boolean }) => ({
      configured: true,
      enabled: input.enabled ?? true,
      allowFrom: [],
    })),
    connectManual: vi.fn(async (input: { appId: string }) => ({
      configured: true,
      enabled: true,
      appId: input.appId,
      allowFrom: [],
    })),
    remove: vi.fn(async () => ({ configured: false, enabled: false, allowFrom: [] })),
    allowAdd: vi.fn(async () => ({ configured: true, enabled: true, allowFrom: [] })),
    allowRemove: vi.fn(async () => ({ configured: true, enabled: true, allowFrom: [] })),
    startRegistration: vi.fn(async () => ({
      state: "qr_ready",
      attempt: 1,
      domain: "feishu",
      qrUrl: "https://example.com/qr",
    })),
    registrationStatus: vi.fn(() => ({ state: "idle", attempt: 0, domain: "feishu" })),
    cancelRegistration: vi.fn(() => ({ state: "cancelled", attempt: 1, domain: "feishu" })),
    ...overrides,
  } as unknown as ChannelOnboardingService;
}

function app(
  options: {
    runtime?: ChannelRuntimeService;
    onboarding?: ChannelOnboardingService;
    tokenConfigured?: boolean;
  } = {},
) {
  return createChannelControlRoutes({
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.onboarding ? { onboarding: options.onboarding } : {}),
    tokenConfigured: options.tokenConfigured ?? true,
  });
}

const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

describe("channel control routes", () => {
  it("returns 503 when the runtime is unavailable", async () => {
    const response = await app().request("/runtime/status");
    expect(response.status).toBe(503);
  });

  it("returns the runtime status", async () => {
    const response = await app({ runtime: fakeRuntime() }).request("/runtime/status");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ bootId: "boot-1" });
  });

  it("rejects writes when no token is configured", async () => {
    const response = await app({
      runtime: fakeRuntime(),
      tokenConfigured: false,
    }).request("/runtime/start", json({}));
    expect(response.status).toBe(503);
  });

  it("maps runtime errors to status codes", async () => {
    const runtime = fakeRuntime({
      start: vi.fn(async () => {
        throw new ChannelRuntimeError("not_configured", "渠道未配置");
      }),
    });
    const response = await app({ runtime }).request("/runtime/start", json({ connector: "feishu" }));
    expect(response.status).toBe(409);
  });

  it("rejects an empty patch body", async () => {
    const response = await app({
      runtime: fakeRuntime(),
      onboarding: fakeOnboarding(),
    }).request("/feishu", { method: "PATCH", body: JSON.stringify({}), headers: { "content-type": "application/json" } });
    expect(response.status).toBe(400);
  });

  it("returns composed config and runtime after a patch", async () => {
    const response = await app({
      runtime: fakeRuntime(),
      onboarding: fakeOnboarding(),
    }).request("/feishu", { method: "PATCH", body: JSON.stringify({ enabled: false }), headers: { "content-type": "application/json" } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      feishu: { enabled: false },
      runtime: { bootId: "boot-1" },
    });
  });

  it("maps verification failures to 400 without echoing the secret", async () => {
    const onboarding = fakeOnboarding({
      connectManual: vi.fn(async () => {
        throw new ChannelOnboardingError("verify_failed", "飞书凭据校验失败");
      }),
    });
    const response = await app({ runtime: fakeRuntime(), onboarding }).request(
      "/feishu/connect",
      json({ appId: "cli_x", appSecret: "super-secret" }),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("super-secret");
  });

  it("decodes the allowlist key on delete", async () => {
    const onboarding = fakeOnboarding();
    const response = await app({ onboarding }).request(
      "/feishu/allow/Alice%2FWork",
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    expect(onboarding.allowRemove).toHaveBeenCalledWith("Alice/Work");
  });

  it("starts and reads registration", async () => {
    const onboarding = fakeOnboarding();
    const routes = app({ onboarding });
    const started = await routes.request("/feishu/registration", json({}));
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({ state: "qr_ready", qrUrl: "https://example.com/qr" });

    const status = await routes.request("/feishu/registration");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ state: "idle" });
  });
});
