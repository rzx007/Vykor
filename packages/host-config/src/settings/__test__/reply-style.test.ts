import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("uses collaborative replies for an existing configuration without a style", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ workStyle: "efficient" }));
    const settings = await loadSettings();
    expect(settings.replyStyle).toBe("collaborative");
    expect(settings.workStyle).toBe("efficient");
  });

  it("persists a reply style independently of progress notifications", async () => {
    await saveSettings({ ...await loadSettings(), replyStyle: "explanatory", workStyle: "efficient" });
    expect(await loadSettings()).toMatchObject({ replyStyle: "explanatory", workStyle: "efficient" });
    expect(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"))).toMatchObject({ replyStyle: "explanatory" });
  });

  it("lets project and explicit settings override the global style", async () => {
    await saveSettings({ ...await loadSettings(), replyStyle: "direct" });
    await saveProjectSettings({ replyStyle: "explanatory" }, configDir);
    expect((await loadSettings(undefined, { projectRoot: configDir, includeProject: true })).replyStyle).toBe("explanatory");
    expect((await loadSettings({ replyStyle: "collaborative" }, { projectRoot: configDir, includeProject: true })).replyStyle).toBe("collaborative");
  });

  it.each(["friendly", "inherit", "", null, 1])("rejects invalid saved and explicit reply style %j", async replyStyle => {
    await expect(loadSettings({ replyStyle } as never)).rejects.toThrow(/replyStyle/);
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ replyStyle }));
    await expect(loadSettings()).rejects.toThrow(/replyStyle/);
  });
});
