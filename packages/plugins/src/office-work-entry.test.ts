import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { validateNativePlugin } from "./manifest/validate.js";
import { loadNativeSkills } from "./components/skills.js";

it("loads the main Agent entry and four official Skills with their plugin source", async () => {
  const root = fileURLToPath(new URL("../../../plugins/office-work/", import.meta.url));
  const validation = await validateNativePlugin(root);
  expect(validation.plugin).toBeDefined();
  const loaded = await loadNativeSkills(validation.plugin!);
  expect(loaded.status).toBe("loaded");
  expect(loaded.value?.map(skill => skill.name).sort()).toEqual([
    "office-work-entry", "officecli", "officecli-docx", "officecli-pptx", "officecli-xlsx",
  ]);
  const entry = loaded.value!.find(skill => skill.name === "office-work-entry")!;
  expect(entry.commandName).toBe("office-work:office-work-entry");
  expect(entry.metadata?.pluginId).toBe("vykor.office-work");
  expect(entry.content).toContain('ToolSearch({"query":"OfficeCLI","limit":1})');
  expect(entry.content).toContain("停止 Office 操作并报告该工具不可用");
});
