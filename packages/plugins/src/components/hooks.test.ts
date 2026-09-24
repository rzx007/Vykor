import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validateNativePlugin } from "../manifest/validate.js";
import { loadNativeHooks } from "./hooks.js";

const fixture = fileURLToPath(new URL("../../fixtures/native-v1/agents-hooks-mcp", import.meta.url));

describe("loadNativeHooks", () => {
  it("loads Vykor event names", async () => {
    const validation = await validateNativePlugin(fixture);
    const result = await loadNativeHooks(validation.plugin!);
    expect(result.status).toBe("loaded");
    expect(result.value?.[0]).toMatchObject({ event: "pre_tool_use", matcher: "Bash" });
  });

  it("rejects Claude event names instead of translating them at runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vk-native-hooks-"));
    try {
      await mkdir(join(root, ".vykor-plugin"));
      await mkdir(join(root, "hooks"));
      await writeFile(join(root, ".vykor-plugin", "plugin.json"), JSON.stringify({
        schemaVersion: 1, id: "dev.vykor.claude-event", name: "claude-event", version: "1",
        components: { hooks: ["./hooks/hooks.json"] },
      }));
      await writeFile(join(root, "hooks", "hooks.json"), JSON.stringify({
        PostToolUse: [{ type: "command", command: "echo no" }],
      }));
      const validation = await validateNativePlugin(root);
      const result = await loadNativeHooks(validation.plugin!);
      expect(result.status).toBe("invalid");
      expect(result.diagnostics[0]?.code).toBe("native_hook_event_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
