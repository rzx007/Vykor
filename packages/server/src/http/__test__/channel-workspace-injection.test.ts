import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelConfigStore } from "@vykor/auth";
import type { Settings } from "@vykor/host-config";
import type { CreateConnectorRuntimeInput } from "../../daemon/channel-runtime-types.js";
import { VykorHttpServer } from "../server.js";
import { runRegisteredDaemon } from "../../daemon-host/registered-daemon.js";

const fixture = vi.hoisted(() => ({ cwd: "" }));
// Keep real assembly and directory creation; stop at the external connector boundary.
vi.mock("../../daemon/channel-runtime-factory.js", () => ({
  createDefaultChannelRuntime: async (input: CreateConnectorRuntimeInput) => {
    fixture.cwd = await input.resolveCwd({ channel: "feishu", accountId: "fixture-app", externalMessageId: "m1",
      senderId: "fixture-sender", chatId: "fixture-chat", content: "", timestamp: new Date(0), media: [], metadata: {} });
    throw new Error("Owned fixture does not start a connector");
  },
}));

afterEach(() => { fixture.cwd = ""; vi.unstubAllEnvs(); });

describe("public channel workspace injection", () => {
  it("keeps registered product channels beside workspaces rather than inside them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-registered-channels-"));
    const root = join(directory, "product");
    vi.stubEnv("VYKOR_CONFIG_DIR", root);
    vi.stubEnv("VYKOR_DATA_DIR", join(root, "data"));
    const config = new ChannelConfigStore(join(directory, "credentials.json"));
    await config.setFeishu({ enabled: true, appId: "fixture-app", appSecret: "fixture-secret", domain: "feishu", allowFrom: {} });
    const stop = new AbortController();
    try {
      await runRegisteredDaemon({ launcher: "cli", version: "fixture", baseDataDirectory: join(root, "data"),
        outsideProjectWorkspaceRoot: join(root, "workspaces"), signal: stop.signal,
        start: async options => {
          const server = new VykorHttpServer({ ...options, channelConfigStore: config,
            settings: { model: "fixture-model" } as Settings, logger: () => {} });
          try {
            await server.application.ready();
            await server.application.channelRuntime!.start("feishu");
            return { listen: { url: "http://127.0.0.1:10000" }, server: {
              store: server.store, close: () => server.close(),
              application: { activateBackgroundWork() { stop.abort(); } },
            } };
          } catch (error) { await server.close(); throw error; }
        },
      });
      expect(dirname(dirname(fixture.cwd))).toBe(join(root, "channels"));
      expect(existsSync(fixture.cwd)).toBe(true);
      expect(existsSync(join(root, "workspaces", "channels"))).toBe(false);
    } finally {
      stop.abort();
      await config.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["product default", "embedding outside root", "explicit channels root"] as const)("creates channel files under the requested root: %s", async mode => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-channel-injection-"));
    const root = join(directory, "product"), outside = join(directory, "outside"), channels = join(directory, "channels-only");
    vi.stubEnv("VYKOR_CONFIG_DIR", root);
    vi.stubEnv("VYKOR_DATA_DIR", join(root, "data"));
    vi.stubEnv("VYKOR_CHANNELS_DIR", join(directory, "ignored-legacy-channels"));
    const config = new ChannelConfigStore(join(directory, "credentials.json"));
    await config.setFeishu({ enabled: true, appId: "fixture-app", appSecret: "fixture-secret", domain: "feishu", allowFrom: {} });
    const server = new VykorHttpServer({ storePath: join(directory, "sessions.db"), channelConfigStore: config,
      settings: { model: "fixture-model" } as Settings, deferBackgroundActivation: true, logger: () => {},
      ...(mode === "product default" ? {} : { outsideProjectWorkspaceRoot: outside }),
      ...(mode === "explicit channels root" ? { channelsWorkspaceRoot: channels } : {}),
    });
    try {
      await server.application.ready();
      await server.application.channelRuntime!.start("feishu");
      const expected = mode === "product default" ? join(root, "channels")
        : mode === "embedding outside root" ? join(outside, "channels") : channels;
      expect(dirname(dirname(fixture.cwd))).toBe(expected);
      expect(existsSync(fixture.cwd)).toBe(true);
      expect(existsSync(join(directory, "ignored-legacy-channels"))).toBe(false);
    } finally {
      await server.close();
      await config.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
