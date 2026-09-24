import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverInstalledNativePlugins,
  installLocalNativePlugin,
  loadNativePlugin,
  validateNativePlugin,
  verifyInstalledNativePlugin,
} from "@vykor/plugins";
import { ClaudeCodePluginConverter } from "./claude-code/converter.js";
import { CodexPluginConverter } from "./codex/converter.js";

const source = fileURLToPath(new URL("../fixtures/claude-code/mixed-plugin", import.meta.url));
const cleanup: string[] = [];
const previousConfigDir = process.env.VYKOR_CONFIG_DIR;
afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
  else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Native Plugin acceptance", () => {
  it("installs a converted Codex plugin only with approved permissions and loads it after the source is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-codex-acceptance-")); cleanup.push(root);
    process.env.VYKOR_CONFIG_DIR = join(root, "config");
    const converter = new CodexPluginConverter();
    const inspection = await converter.inspect(fileURLToPath(new URL("../fixtures/codex/mixed-plugin", import.meta.url)));
    const plan = await converter.plan(inspection);
    const output = join(root, "converted");
    await converter.convert({ inspection, plan, output, approvals: plan.items.flatMap(item => item.requiredApprovals ?? []) });
    const denied = await installLocalNativePlugin({ sourcePath: output, scope: "user", cwd: root, approvedPermissions: [] });
    expect(denied.status).toBe("blocked");
    expect(await discoverInstalledNativePlugins({ cwd: root })).toHaveLength(0);
    const installed = await installLocalNativePlugin({ sourcePath: output, scope: "user", cwd: root, approvedPermissions: ["network:https://docs.example.invalid"] });
    expect(installed.status).toBe("installed");
    if (installed.status !== "installed") throw new Error("Expected installed Codex fixture");
    expect(installed.record).toMatchObject({ origin: "converted", sourceFormat: "codex", requestedPermissions: ["network:https://docs.example.invalid"], enabled: true });
    await rm(output, { recursive: true, force: true });
    const records = await discoverInstalledNativePlugins({ cwd: root });
    expect(records).toHaveLength(1);
    const verified = await verifyInstalledNativePlugin(records[0]!);
    expect(verified.status).toBe("valid");
    if (verified.status !== "valid") throw new Error("Expected valid installed Codex snapshot");
    const loaded = await loadNativePlugin(verified.plugin);
    expect(loaded.status).toBe("loaded");
    expect(loaded.components.skills?.value).toHaveLength(1);
    expect(loaded.components.mcpServers?.value?.docs).toEqual({ type: "http", url: "https://docs.example.invalid/mcp" });
    expect(loaded.components.tools).toBeUndefined();
  });

  it("converts, validates, installs, discovers and loads a Claude source without executing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-plugin-acceptance-")); cleanup.push(root);
    process.env.VYKOR_CONFIG_DIR = join(root, "config");
    const converter = new ClaudeCodePluginConverter();
    const inspection = await converter.inspect(source);
    const plan = await converter.plan(inspection);
    const output = join(root, "converted");
    expect((await converter.convert({ inspection, plan, output, approvals: [] })).status).toBe("success");
    const validation = await validateNativePlugin(output);
    expect(validation.status).toBe("valid");
    const installed = await installLocalNativePlugin({ sourcePath: output, scope: "user", cwd: root, approvedPermissions: [] });
    expect(installed.status).toBe("installed");
    if (installed.status !== "installed") return;
    expect(installed.record.origin).toBe("converted");
    expect(installed.record.sourceFormat).toBe("claude-code");
    expect(installed.record.cachePath).toBe(join(
      root,
      "config",
      "plugins",
      "cache",
      "converted.claude.mixed-plugin",
      `2.0.0-${installed.record.behaviorDigest}`,
    ));
    expect((await readdir(installed.record.cachePath)).sort()).toEqual([
      ".vykor-conversion",
      ".vykor-plugin",
      "agents",
      "hooks.json",
      "mcp.json",
      "skills",
    ]);
    await expect(access(join(installed.record.cachePath, "payload"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(installed.record.cachePath, "generated"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(installed.record.cachePath, ".claude-plugin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await discoverInstalledNativePlugins({ cwd: root })).toHaveLength(1);
    const installedValidation = await validateNativePlugin(installed.record.cachePath);
    expect(installedValidation.status).toBe("valid");
    const loaded = await loadNativePlugin(installedValidation.plugin!);
    expect(loaded.status).toBe("loaded");
    expect(loaded.components.skills?.value?.length).toBeGreaterThan(0);
    expect(loaded.components.agents?.value?.length).toBeGreaterThan(0);
  });
});
