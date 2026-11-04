import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveProjectSettings, saveSettings } from "../settings.js";

describe("reply style settings", () => {
  let configDir: string;
  let previousConfigDir: string | undefined;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "vykor-reply-style-"));
    previousConfigDir = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.VYKOR_CONFIG_DIR;
    else process.env.VYKOR_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("discards retired styles from existing settings and the next save", async () => {
    const path = join(configDir, "settings.json");
    writeFileSync(path, JSON.stringify({ workStyle: "efficient", replyStyle: "explanatory", maxTurns: 25 }));
    const settings = await loadSettings(undefined, { includeEnvironment: false });
    expect(settings).toMatchObject({ maxTurns: 25 });
    expect(settings).not.toHaveProperty("workStyle");
    expect(settings).not.toHaveProperty("replyStyle");
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("workStyle");
    await saveSettings(settings);
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("workStyle");
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("replyStyle");
  });

  it("ignores retired fields in old project settings without hiding current settings", async () => {
    const project = join(configDir, "project");
    const path = join(project, ".vykor", "settings.json");
    mkdirSync(join(project, ".vykor"), { recursive: true });
    writeFileSync(path, JSON.stringify({ workStyle: "old", replyStyle: null, showReasoning: true }));
    const settings = await loadSettings(undefined, { includeEnvironment: false, includeProject: true, projectRoot: project });
    expect(settings.showReasoning).toBe(true);
    expect(settings).not.toHaveProperty("workStyle");
    expect(settings).not.toHaveProperty("replyStyle");
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("replyStyle");
  });

  it.each(["workStyle", "replyStyle"])("rejects new writes for %s", async (field) => {
    await expect(loadSettings({ [field]: "old" } as never)).rejects.toThrow(/Unknown config key/);
    await expect(saveSettings({ ...await loadSettings(), [field]: "old" } as never)).rejects.toThrow(/Unknown config key/);
    await expect(saveProjectSettings({ [field]: "old" } as never, configDir)).rejects.toThrow(/Unknown config key/);
  });
});
