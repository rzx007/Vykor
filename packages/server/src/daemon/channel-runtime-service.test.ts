import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Settings } from "@openharness/core";
import type { FeishuChannelConfig } from "@openharness/auth";
import type { InboundMessage } from "@openharness/channels";

import {
  ChannelRuntimeError,
  ChannelRuntimeService,
  type ChannelRuntimeApplicationPort,
  type ChannelRuntimeServiceOptions,
  type ConnectorRuntimeHandle,
} from "./channel-runtime-service.js";

const feishuConfig = (patch: Partial<FeishuChannelConfig> = {}): FeishuChannelConfig => ({
  enabled: true,
  appId: "cli_x",
  appSecret: "sec",
  domain: "feishu",
  allowFrom: { me: "ou_me" },
  ...patch,
});

function fakeHandle(overrides: Partial<ConnectorRuntimeHandle> = {}) {
  const calls = { start: 0, stopInbound: 0, stopBridge: 0, stop: 0 };
  const handle: ConnectorRuntimeHandle = {
    start: async () => {
      calls.start += 1;
    },
    stopInbound: async () => {
      calls.stopInbound += 1;
    },
    stopBridge: async () => {
      calls.stopBridge += 1;
    },
    stop: async () => {
      calls.stop += 1;
    },
    ...overrides,
  };
  return { handle, calls };
}

function application(): ChannelRuntimeApplicationPort {
  return {
    handleMessage: vi.fn(async () => {
      throw new Error("not used");
    }),
    pendingDeliveries: vi.fn(async () => []),
    recordDelivery: vi.fn(async (id, input) => ({
      id,
      conversationId: "c",
      connector: "feishu",
      accountId: "a",
      chatId: "chat",
      sessionId: "s",
      inputId: "i",
      runId: "r",
      externalMessageId: "e",
      content: "x",
      status: input.status,
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

function makeService(overrides: Partial<ChannelRuntimeServiceOptions> = {}) {
  const config = { current: feishuConfig() as FeishuChannelConfig | undefined };
  const created: Array<{
    handle: ConnectorRuntimeHandle;
    calls: ReturnType<typeof fakeHandle>["calls"];
    input: Parameters<NonNullable<ChannelRuntimeServiceOptions["createRuntime"]>>[0];
  }> = [];
  const service = new ChannelRuntimeService({
    application: application(),
    config: { getFeishu: async () => config.current },
    getSettings: () => ({ model: "model-1" }) as Settings,
    workspaceRoot: mkdtempSync(join(tmpdir(), "ohs-channel-ws-")),
    createRuntime: async (input) => {
      const { handle, calls } = fakeHandle();
      created.push({ handle, calls, input });
      return handle;
    },
    verify: async () => ({ name: "Harness Bot" }),
    ...overrides,
  });
  return { service, config, created };
}

const inbound = (patch: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "feishu",
  accountId: "cli_x",
  externalMessageId: "m1",
  senderId: "ou_me",
  chatId: "chat-1",
  content: "hi",
  timestamp: new Date(0),
  media: [],
  metadata: {},
  ...patch,
});

describe("ChannelRuntimeService", () => {
  it("starts only enabled connectors and reports running", async () => {
    const { service, created } = makeService();
    await service.startEnabled();
    expect(created).toHaveLength(1);
    expect(created[0]!.calls.start).toBe(1);
    expect(service.status().connectors[0]).toMatchObject({
      connector: "feishu",
      enabled: true,
      state: "running",
    });
  });

  it("does not start a disabled connector", async () => {
    const { service, created, config } = makeService();
    config.current = feishuConfig({ enabled: false });
    await service.startEnabled();
    expect(created).toHaveLength(0);
    expect(service.status().connectors[0]).toMatchObject({ state: "stopped", enabled: false });
  });

  it("records an error (without throwing) when the model is missing", async () => {
    const { service } = makeService({ getSettings: () => ({}) as Settings });
    await service.start("feishu");
    expect(service.status().connectors[0]).toMatchObject({
      state: "error",
      lastError: expect.stringMatching(/模型/),
    });
  });

  it("never rejects startEnabled even when the config store throws", async () => {
    const { service } = makeService({
      config: {
        getFeishu: async () => {
          throw new Error("corrupt config");
        },
      },
    });
    await expect(service.startEnabled()).resolves.toBeUndefined();
    expect(service.status().connectors[0]).toMatchObject({
      state: "error",
      lastError: expect.stringMatching(/corrupt config/),
    });
  });

  it("marks an error when connecting exceeds the timeout", async () => {
    const { service, created } = makeService({
      connectTimeoutMs: 10,
      createRuntime: async (input) => {
        const { handle, calls } = fakeHandle({
          start: () => new Promise<void>(() => {}),
        });
        created.push({ handle, calls, input });
        return handle;
      },
    });
    await service.start("feishu");
    expect(service.status().connectors[0]).toMatchObject({
      state: "error",
      lastError: expect.stringMatching(/连接超时/),
    });
    expect(created[0]!.calls.stop).toBe(1);
  });

  it("does not connect when shutdown races an in-flight start", async () => {
    let release!: () => void;
    const { service, created } = makeService({
      createRuntime: async (input) => {
        const { handle, calls } = fakeHandle({
          start: () => new Promise<void>((resolve) => (release = resolve)),
        });
        created.push({ handle, calls, input });
        return handle;
      },
    });
    const starting = service.start("feishu");
    await vi.waitFor(() => {
      expect(typeof release).toBe("function");
    });
    const stopping = service.shutdown();
    release();
    await starting;
    await stopping;
    expect(service.status().connectors[0]?.state).toBe("stopped");
    expect(created[0]!.calls.stop).toBe(1);
  });

  it("converges to stopped when stop follows a queued start", async () => {
    const { service, created } = makeService();
    const starting = service.start();
    const stopping = service.stop();
    await Promise.all([starting, stopping]);
    expect(created).toHaveLength(1);
    expect(created[0]!.calls.stop).toBe(1);
    expect(service.status().connectors[0]?.state).toBe("stopped");
  });

  it("rejects start when no connector is configured", async () => {
    const { service, config } = makeService();
    config.current = undefined;
    await expect(service.start("feishu")).rejects.toMatchObject({ code: "not_configured" });
  });

  it("converges to stopped when stop is queued while start hangs", async () => {
    let release!: () => void;
    const { service, created } = makeService({
      createRuntime: async (input) => {
        const { handle, calls } = fakeHandle({
          start: () => new Promise<void>((resolve) => (release = resolve)),
        });
        created.push({ handle, calls, input });
        return handle;
      },
    });
    const starting = service.start("feishu");
    await vi.waitFor(() => {
      expect(typeof release).toBe("function");
    });
    const stopping = service.stop("feishu");
    release();
    await starting;
    await stopping;
    expect(service.status().connectors[0]?.state).toBe("stopped");
    expect(created[0]!.calls.stop).toBe(1);
  });

  it("keeps a single runtime across restarts", async () => {
    const { service, created } = makeService();
    await service.start("feishu");
    await service.restart("feishu");
    expect(created).toHaveLength(2);
    expect(created[0]!.calls.stop).toBe(1);
    expect(service.status().connectors[0]?.state).toBe("running");
  });

  it("updates ACL in place without restarting when only allowFrom changes", async () => {
    const { service, created, config } = makeService();
    await service.start("feishu");
    const acl = created[0]!.input.acl;
    expect(acl.allowFrom).toEqual(["ou_me"]);
    config.current = feishuConfig({ allowFrom: { me: "ou_me", other: "ou_other" } });
    await service.applyFeishuConfig(config.current);
    expect(created).toHaveLength(1);
    expect(acl.allowFrom).toEqual(["ou_me", "ou_other"]);
  });

  it("restarts when the connection fingerprint changes", async () => {
    const { service, created, config } = makeService();
    await service.start("feishu");
    config.current = feishuConfig({ appId: "cli_new" });
    await service.applyFeishuConfig(config.current);
    expect(created).toHaveLength(2);
    expect(created[0]!.calls.stop).toBe(1);
  });

  it("records bounded, monotonic denial notices under a stable bootId", async () => {
    const { service, created } = makeService();
    await service.start("feishu");
    const bootId = service.status().bootId;
    const onDenied = created[0]!.input.onDenied;
    for (let index = 0; index < 60; index += 1) {
      onDenied({ channel: "feishu", sender: `ou_${index}`, chatId: "chat-1" });
    }
    const status = service.status();
    expect(bootId).toBe(status.bootId);
    expect(status.recentDenials).toHaveLength(50);
    const seqs = status.recentDenials.map((denial) => denial.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(50);
  });

  it("resolves distinct workspace directories per session key", async () => {
    const { service, created } = makeService();
    await service.start("feishu");
    const resolveCwd = created[0]!.input.resolveCwd;
    const a = await resolveCwd(inbound({ chatId: "chat-1" }));
    const b = await resolveCwd(inbound({ chatId: "chat-2" }));
    const c = await resolveCwd(inbound({ chatId: "chat-1", threadId: "t1" }));
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("records a lastError when the workspace cannot be created", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "ohs-channel-bad-")), "file");
    writeFileSync(root, "not a directory");
    const { service, created } = makeService({ workspaceRoot: root });
    await service.start("feishu");
    await expect(created[0]!.input.resolveCwd(inbound())).rejects.toThrow();
    expect(service.status().connectors[0]?.lastError).toMatch(/工作目录/);
  });

  it("shuts down all runtimes and rejects later starts", async () => {
    const { service, created } = makeService();
    await service.start("feishu");
    await service.shutdown();
    expect(created[0]!.calls.stop).toBe(1);
    await expect(service.start("feishu")).rejects.toMatchObject({ code: "closed" });
    await expect(service.stop("feishu")).rejects.toBeInstanceOf(ChannelRuntimeError);
  });

  it("forwards attachment downloads to the running handle's downloader", async () => {
    const downloadAttachment = vi.fn(async () => ({
      stream: new ReadableStream<Uint8Array>(),
      mimeType: "image/png",
    }));
    const { service } = makeService({
      createRuntime: async () => fakeHandle({ downloadAttachment }).handle,
    });
    await service.start("feishu");

    const result = await service.downloadAttachment("msg-1", {
      type: "image",
      externalId: "img_v2_1",
    });

    expect(downloadAttachment).toHaveBeenCalledWith({
      messageId: "msg-1",
      type: "image",
      externalId: "img_v2_1",
    });
    expect(result?.mimeType).toBe("image/png");
  });

  it("returns undefined before start and after stop", async () => {
    const downloadAttachment = vi.fn(async () => ({ stream: new ReadableStream<Uint8Array>() }));
    const { service } = makeService({
      createRuntime: async () => fakeHandle({ downloadAttachment }).handle,
    });

    await expect(
      service.downloadAttachment("m", { type: "file", externalId: "f" }),
    ).resolves.toBeUndefined();

    await service.start("feishu");
    await service.stop("feishu");

    await expect(
      service.downloadAttachment("m", { type: "file", externalId: "f" }),
    ).resolves.toBeUndefined();
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  it("returns undefined when the handle exposes no downloader", async () => {
    const { service } = makeService();
    await service.start("feishu");
    await expect(
      service.downloadAttachment("m", { type: "image", externalId: "k" }),
    ).resolves.toBeUndefined();
  });
});
