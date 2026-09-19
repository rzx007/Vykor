import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelConfigStore } from "@openharness/auth";
import type { Settings } from "@openharness/core";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@openharness/protocol";

import { OpenHarnessHttpServer } from "../../http/server.js";
import { createDefaultNodeApplication } from "../default-node-application.js";

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "ohs-daemon-channel-"));
  return {
    storePath: join(dir, "sessions.db"),
    configPath: join(dir, "channel-credentials.json"),
  };
}

const settings = { model: "model-1" } as Settings;

describe("daemon channel assembly", () => {
  it("only builds channel services when a config store is provided", async () => {
    const { storePath } = tempPaths();
    const withoutStore = createDefaultNodeApplication({
      storePath,
      settings,
      log: () => {},
    });
    expect(withoutStore.channelRuntime).toBeUndefined();
    expect(withoutStore.channelOnboarding).toBeUndefined();
    await withoutStore.close();

    const { storePath: secondStorePath, configPath } = tempPaths();
    const withStore = createDefaultNodeApplication({
      storePath: secondStorePath,
      settings,
      log: () => {},
      channelConfigStore: new ChannelConfigStore(configPath),
    });
    expect(withStore.channelRuntime).toBeDefined();
    expect(withStore.channelOnboarding).toBeDefined();
    await withStore.ready();
    await withStore.close();
  });

  it("serves channel control routes and rejects starting an unconfigured channel", async () => {
    const { storePath, configPath } = tempPaths();
    const server = new OpenHarnessHttpServer({
      storePath,
      token: "token-1",
      settings,
      channelConfigStore: new ChannelConfigStore(configPath),
    });
    const auth = {
      authorization: "Bearer token-1",
      [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION),
    };

    const status = await server.app.request("/channels/runtime/status", { headers: auth });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      connectors: [expect.objectContaining({ connector: "feishu", state: "stopped" })],
    });

    const start = await server.app.request("/channels/runtime/start", {
      method: "POST",
      body: JSON.stringify({ connector: "feishu" }),
      headers: { ...auth, "content-type": "application/json" },
    });
    expect(start.status).toBe(409);

    await server.close();
  });
});
