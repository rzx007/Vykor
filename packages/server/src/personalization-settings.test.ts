import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectSettings, loadSettings } from "@vykor/core";
import {
  inspectPersonalizationSettings,
  saveMemoryConfiguration,
} from "./personalization-settings.js";

describe("personalization configuration", () => {
  it("preserves user defaults, project inheritance, conflict checks and unrelated config", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "vk-personalization-config-"),
    );
    const previous = process.env.VYKOR_CONFIG_DIR;
    process.env.VYKOR_CONFIG_DIR = directory;
    try {
      const project = join(directory, "project");
      await mkdir(join(project, ".vykor"), { recursive: true });
      await writeFile(
        join(project, ".vykor", "settings.json"),
        JSON.stringify({ systemPrompt: "Keep this instruction" }),
      );
      await writeFile(join(project, "AGENTS.md"), "Project rules");
      const user = await inspectPersonalizationSettings();
      const preferences = {
        ...user.effective,
        autoDreamEnabled: true,
        autoDreamMinHours: 48,
        autoDreamMinSessions: 7,
      };
      await saveMemoryConfiguration({
        value: preferences,
        expected: user.configured,
      });
      expect((await loadSettings()).memory?.autoDreamMinHours).toBe(48);
      const inherited = await inspectPersonalizationSettings({ cwd: project });
      expect(inherited.configured).toBeNull();
      expect(inherited.sources.autoDreamEnabled).toBe("用户默认");
      expect(inherited.rules).toContain(join(project, "AGENTS.md"));
      await saveMemoryConfiguration({
        cwd: project,
        value: { ...preferences, sessionMemoryEnabled: false },
        expected: null,
      });
      expect((await loadProjectSettings(project))?.systemPrompt).toBe(
        "Keep this instruction",
      );
      const overridden = await inspectPersonalizationSettings({ cwd: project });
      expect(overridden.effective.sessionMemoryEnabled).toBe(false);
      expect(overridden.sources.sessionMemoryEnabled).toBe("当前项目");
      await expect(
        saveMemoryConfiguration({
          cwd: project,
          value: preferences,
          expected: null,
        }),
      ).rejects.toThrow();
      await saveMemoryConfiguration({
        cwd: project,
        value: null,
        expected: overridden.configured,
      });
      expect(
        (await inspectPersonalizationSettings({ cwd: project })).effective
          .sessionMemoryEnabled,
      ).toBe(true);
      await expect(
        saveMemoryConfiguration({
          value: { ...preferences, autoDreamMinSessions: 0 },
          expected: (await inspectPersonalizationSettings()).configured,
        }),
      ).rejects.toThrow("门槛无效");
    } finally {
      if (previous === undefined) delete process.env.VYKOR_CONFIG_DIR;
      else process.env.VYKOR_CONFIG_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
