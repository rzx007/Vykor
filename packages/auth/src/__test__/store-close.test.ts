import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { CredentialStorage } from "../credentials/credential-storage.js";
import { McpOAuthCredentialStore } from "../mcp/mcp-oauth-credential-store.js";
import { ChannelConfigStore } from "../channels/channel-config-store.js";

it("drains all accepted credential writes and rejects reuse after close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vykor-close-stores-"));
  try {
    const credentials = new CredentialStorage(join(directory, "credentials.json"));
    const write = credentials.storeApiKey("test", "temporary");
    await Promise.all([write, credentials.close()]);
    await expect(credentials.loadApiKey("test")).rejects.toThrow(/closed/i);
    expect(await new CredentialStorage(join(directory, "credentials.json")).loadApiKey("test")).toBe("temporary");

    const oauth = new McpOAuthCredentialStore(join(directory, "oauth.json"));
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = oauth.runExclusive("test", async () => { entered(); await waiting; return { next: undefined, result: "done" }; });
    await started;
    let closed = false; const closing = oauth.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); expect(await pending).toBe("done"); await closing;
    await expect(oauth.get("test")).rejects.toThrow(/closed/i);
    await expect(oauth.list()).rejects.toThrow(/closed/i);

    const file = join(directory, "channels.json");
    await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid }));
    const channels = new ChannelConfigStore(file);
    const config = { enabled: true, appId: "test-app", appSecret: "temporary-secret", domain: "feishu" as const, allowFrom: {} };
    const channelWrite = channels.setFeishu(config);
    const channelClose = channels.close();
    await rm(`${file}.lock`);
    await Promise.all([channelWrite, channelClose]);
    await expect(channels.getFeishu()).rejects.toThrow(/closed/i);
    expect(await new ChannelConfigStore(file).getFeishu()).toEqual(config);
    expect(JSON.parse(await readFile(file, "utf8")).channels.feishu.appId).toBe("test-app");
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
