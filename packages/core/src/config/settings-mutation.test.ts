import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings } from "./settings.js";
import {
  SettingsConflictError,
  SettingsLockTimeoutError,
  updateSettings,
  withSettingsFileLock,
} from "./settings-mutation.js";

const settingsPath = (configDir: string) => join(configDir, "settings.json");
const lockPath = (configDir: string) => `${settingsPath(configDir)}.lock`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("global settings transactional writes", () => {
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "openharness-mutation-"));
    previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
    else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("serializes concurrent writers so both field updates survive on disk", async () => {
    const first = updateSettings(async (current) => {
      await delay(150);
      return { ...current, outputStyle: "concise" };
    });
    await delay(40);
    const second = updateSettings((current) => ({ ...current, effort: "high" }));
    await Promise.all([first, second]);

    const raw = JSON.parse(readFileSync(settingsPath(configDir), "utf8")) as {
      outputStyle?: string;
      effort?: string;
    };
    expect(raw.outputStyle).toBe("concise");
    expect(raw.effort).toBe("high");
  });

  it("lets a waiting writer observe the value written by the previous lock holder", async () => {
    const observed: string[] = [];
    const first = updateSettings(async (current) => {
      await delay(150);
      return { ...current, outputStyle: "concise" };
    });
    await delay(40);
    const second = updateSettings((current) => {
      observed.push(current.outputStyle ?? "<unset>");
      return { ...current, effort: "high" };
    });
    await Promise.all([first, second]);

    expect(observed).toEqual(["concise"]);
  });

  it("aborts without writing when the edit target changed and reports a conflict", async () => {
    const stale = await loadSettings();
    await updateSettings((current) => ({ ...current, outputStyle: "external" }));

    await expect(
      updateSettings((current) => {
        if (current.outputStyle !== stale.outputStyle) {
          throw new SettingsConflictError("outputStyle");
        }
        return { ...current, outputStyle: "mine" };
      }),
    ).rejects.toMatchObject({ code: "settings_conflict", name: "SettingsConflictError" });

    expect((await loadSettings()).outputStyle).toBe("external");
    expect(existsSync(lockPath(configDir))).toBe(false);
  });

  it("releases the lock when the change function throws", async () => {
    await expect(
      updateSettings(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(existsSync(lockPath(configDir))).toBe(false);
    await updateSettings((current) => ({ ...current, effort: "high" }));
    expect((await loadSettings()).effort).toBe("high");
  });

  it("recovers a lock left behind by a crashed writer", async () => {
    writeFileSync(lockPath(configDir), "stale");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath(configDir), past, past);

    await updateSettings((current) => ({ ...current, effort: "high" }));

    expect((await loadSettings()).effort).toBe("high");
    expect(existsSync(lockPath(configDir))).toBe(false);
  });

  it("times out with a typed error when a fresh lock is held by another writer", async () => {
    writeFileSync(lockPath(configDir), "held");

    await expect(
      updateSettings((current) => ({ ...current, effort: "high" }), {
        timeoutMs: 60,
        pollIntervalMs: 10,
        staleMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(SettingsLockTimeoutError);

    expect(readFileSync(lockPath(configDir), "utf8")).toBe("held");
  });

  it("exposes the generic file lock primitive", async () => {
    const order: string[] = [];
    await withSettingsFileLock(async () => {
      order.push("inside");
    });
    order.push("after");

    expect(order).toEqual(["inside", "after"]);
    expect(existsSync(lockPath(configDir))).toBe(false);
  });

  it("keeps an MCP add and an unrelated settings update from clobbering each other", async () => {
    const add = updateSettings(async (current) => {
      await delay(150);
      return {
        ...current,
        mcpServers: {
          ...(current.mcpServers ?? {}),
          linear: { type: "http" as const, url: "https://mcp.linear.app/mcp" },
        },
      };
    });
    await delay(40);
    const preference = updateSettings((current) => ({
      ...current,
      outputStyle: "concise",
    }));
    await Promise.all([add, preference]);

    const settings = await loadSettings();
    expect(settings.outputStyle).toBe("concise");
    expect(settings.mcpServers?.linear).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
    });
  });

  it("persists two concurrently added MCP servers without losing either", async () => {
    const first = updateSettings(async (current) => {
      await delay(120);
      return {
        ...current,
        mcpServers: {
          ...(current.mcpServers ?? {}),
          beui: { type: "stdio" as const, command: "npx", args: ["beui"] },
        },
      };
    });
    await delay(30);
    const second = updateSettings((current) => ({
      ...current,
      mcpServers: {
        ...(current.mcpServers ?? {}),
        linear: { type: "http" as const, url: "https://mcp.linear.app/mcp" },
      },
    }));
    await Promise.all([first, second]);

    const names = Object.keys((await loadSettings()).mcpServers ?? {}).sort();
    expect(names).toEqual(["beui", "linear"]);
  });
});
