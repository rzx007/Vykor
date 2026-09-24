import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChannelConfigStore, type FeishuChannelConfig } from "@vykor/auth";
import type {
  FeishuRegistrationCredentials,
  FeishuRegistrationStatus,
} from "@vykor/channels";

import {
  ChannelOnboardingService,
  type RegistrationLike,
} from "../channel-onboarding-service.js";

function makeStore() {
  const path = join(mkdtempSync(join(tmpdir(), "vk-onboarding-")), "channel-credentials.json");
  return new ChannelConfigStore(path);
}

async function seededStore(config?: FeishuChannelConfig) {
  const store = makeStore();
  if (config) await store.setFeishu(config);
  return store;
}

const feishu = (patch: Partial<FeishuChannelConfig> = {}): FeishuChannelConfig => ({
  enabled: true,
  appId: "cli_x",
  appSecret: "sec",
  domain: "feishu",
  allowFrom: { me: "ou_me" },
  ...patch,
});

function fakeRegistration() {
  let onCredentials:
    | ((credentials: FeishuRegistrationCredentials) => Promise<void>)
    | undefined;
  let status: FeishuRegistrationStatus = {
    state: "idle",
    attempt: 0,
    domain: "feishu",
  };
  const registration: RegistrationLike = {
    start(options) {
      status = {
        state: "qr_ready",
        attempt: status.attempt + 1,
        domain: options?.domain ?? "feishu",
        qrUrl: "https://example.com/qr",
        expiresAt: 123,
      };
      return status;
    },
    status: () => status,
    cancel() {
      status = { ...status, state: "cancelled" };
      return status;
    },
  };
  return {
    registration,
    async succeed(credentials: FeishuRegistrationCredentials) {
      await onCredentials!(credentials);
      status = { ...status, state: "succeeded" };
    },
    setOnCredentials(fn: typeof onCredentials) {
      onCredentials = fn;
    },
  };
}

function makeService(
  options: {
    store?: ChannelConfigStore;
    onConfigChanged?: (connector: string) => Promise<void> | void;
    verify?: (input: { appId: string; appSecret: string; domain: "feishu" | "lark" }) => Promise<{
      name?: string;
    }>;
    readBotName?: () => string | undefined;
  } = {},
) {
  const fake = fakeRegistration();
  const store = options.store ?? makeStore();
  const onConfigChanged = vi.fn(options.onConfigChanged ?? (async () => {}));
  const service = new ChannelOnboardingService({
    config: store,
    onConfigChanged,
    createRegistration: (onCredentials) => {
      fake.setOnCredentials(onCredentials);
      return fake.registration;
    },
    verify: options.verify ?? (async () => ({ name: "Harness Bot" })),
    ...(options.readBotName ? { readBotName: options.readBotName } : {}),
  });
  return { service, store, fake, onConfigChanged };
}

describe("ChannelOnboardingService", () => {
  it("returns an unconfigured snapshot when nothing is stored", async () => {
    const { service } = makeService();
    await expect(service.snapshot()).resolves.toEqual({
      configured: false,
      enabled: false,
      allowFrom: [],
    });
  });

  it("does not write config when manual verification fails", async () => {
    const store = await seededStore();
    const { service } = makeService({
      store,
      verify: async () => {
        throw new Error("bad credentials");
      },
    });
    await expect(
      service.connectManual({ appId: "cli_x", appSecret: "sec" }),
    ).rejects.toMatchObject({ code: "verify_failed" });
    expect(await store.getFeishu()).toBeUndefined();
  });

  it("writes enabled config with the default feishu domain on manual connect", async () => {
    const store = await seededStore();
    const { service, onConfigChanged } = makeService({ store });
    const snapshot = await service.connectManual({ appId: "cli_new", appSecret: "sec" });
    expect(snapshot).toMatchObject({ configured: true, enabled: true, appId: "cli_new" });
    expect((await store.getFeishu())?.domain).toBe("feishu");
    expect(onConfigChanged).toHaveBeenCalledWith("feishu");
  });

  it("clears the allowlist when the appId changes and keeps it otherwise", async () => {
    const store = await seededStore(feishu());
    const { service } = makeService({ store });
    await service.connectManual({ appId: "cli_x", appSecret: "sec" });
    expect((await store.getFeishu())?.allowFrom).toEqual({ me: "ou_me" });

    await service.connectManual({ appId: "cli_other", appSecret: "sec" });
    expect((await store.getFeishu())?.allowFrom).toEqual({});
  });

  it("patches enabled and behavior flags, rejecting an unconfigured channel", async () => {
    const store = await seededStore(feishu());
    const { service } = makeService({ store });
    const snapshot = await service.patch({ enabled: false, sendProgress: false });
    expect(snapshot).toMatchObject({ enabled: false, sendProgress: false });
    expect((await store.getFeishu())?.sendToolHints).toBeUndefined();

    const empty = makeService();
    await expect(empty.service.patch({ enabled: true })).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("adds allowlist entries keyed by name and removes by key", async () => {
    const store = await seededStore(feishu());
    const { service } = makeService({ store });
    await service.allowAdd({ id: "ou_other" });
    expect((await store.getFeishu())?.allowFrom).toEqual({
      me: "ou_me",
      ou_other: "ou_other",
    });
    await service.allowAdd({ id: "ou_third", name: "Alice/Work" });
    await service.allowRemove("Alice/Work");
    expect((await store.getFeishu())?.allowFrom).toEqual({
      me: "ou_me",
      ou_other: "ou_other",
    });
  });

  it("writes scanner credentials, merges the scanner open_id and clears the old app allowlist", async () => {
    const store = await seededStore(feishu());
    const { service, fake } = makeService({ store });
    await service.startRegistration({ domain: "feishu" });
    await fake.succeed({
      appId: "cli_scanned",
      appSecret: "scanned-secret",
      userId: "ou_scanner",
      domain: "feishu",
    });
    expect(await store.getFeishu()).toMatchObject({
      enabled: true,
      appId: "cli_scanned",
      allowFrom: { ou_scanner: "ou_scanner" },
    });
    expect(service.registrationStatus()).toMatchObject({
      state: "succeeded",
      attempt: 1,
      domain: "feishu",
    });
  });

  it("keeps registration succeeded when the runtime callback fails", async () => {
    const store = await seededStore();
    const writeSpy = vi.spyOn(store, "updateFeishu");
    const { service, fake } = makeService({
      store,
      onConfigChanged: () => {
        throw new Error("runtime boom");
      },
    });
    await service.startRegistration();
    await fake.succeed({
      appId: "cli_scanned",
      appSecret: "scanned-secret",
      userId: "ou_scanner",
      domain: "feishu",
    });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(service.registrationStatus().state).toBe("succeeded");
    expect(await store.getFeishu()).toBeDefined();
  });

  it("warns and leaves the allowlist empty when the scanner open_id is missing", async () => {
    const store = await seededStore();
    const { service, fake } = makeService({ store });
    await service.startRegistration();
    await fake.succeed({
      appId: "cli_scanned",
      appSecret: "scanned-secret",
      domain: "feishu",
    });
    expect((await store.getFeishu())?.allowFrom).toEqual({});
    expect(service.registrationStatus().warning).toMatch(/白名单为空/);
  });

  it("increments the attempt on repeated starts and cancels idempotently", async () => {
    const { service } = makeService();
    await service.startRegistration();
    await service.startRegistration();
    expect(service.registrationStatus()).toMatchObject({ attempt: 2, state: "qr_ready" });
    expect(service.cancelRegistration().state).toBe("cancelled");
    expect(service.cancelRegistration().state).toBe("cancelled");
  });

  it("reports idle from a fresh instance", () => {
    const { service } = makeService();
    expect(service.registrationStatus()).toMatchObject({ state: "idle" });
  });

  it("exposes a configured snapshot with allowlist pairs and cached bot name", async () => {
    const store = await seededStore(feishu());
    const { service } = makeService({ store, readBotName: () => "Harness Bot" });
    await expect(service.snapshot()).resolves.toMatchObject({
      configured: true,
      enabled: true,
      appId: "cli_x",
      botName: "Harness Bot",
      allowFrom: [{ name: "me", id: "ou_me" }],
    });
  });

  it("rejects unsafe allowlist names", async () => {
    const store = await seededStore(feishu());
    const { service } = makeService({ store });
    await expect(service.allowAdd({ id: "ou_x", name: "__proto__" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("creates a single registration instance for concurrent starts", async () => {
    const fake = fakeRegistration();
    let factoryCalls = 0;
    const service = new ChannelOnboardingService({
      config: makeStore(),
      onConfigChanged: () => {},
      createRegistration: (onCredentials) => {
        factoryCalls += 1;
        fake.setOnCredentials(onCredentials);
        return fake.registration;
      },
    });
    await Promise.all([service.startRegistration(), service.startRegistration()]);
    expect(factoryCalls).toBe(1);
    expect(service.registrationStatus().attempt).toBe(2);
  });

  it("removes the channel and reports unconfigured", async () => {
    const store = await seededStore(feishu());
    const { service } = makeService({ store });
    await expect(service.remove()).resolves.toEqual({
      configured: false,
      enabled: false,
      allowFrom: [],
    });
    expect(await store.getFeishu()).toBeUndefined();
  });
});
