import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateNativePlugin } from "./validate.js";

let root: string;

async function writeManifest(value: unknown): Promise<void> {
  const manifestDir = join(root, ".vykor-plugin");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, "plugin.json"), JSON.stringify(value));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vk-native-validate-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("validateNativePlugin", () => {
  it("returns a validated plugin and no diagnostics for a valid artifact", async () => {
    await mkdir(join(root, "skills"));
    await writeManifest({
      schemaVersion: 1,
      id: "dev.vykor.valid",
      name: "valid-plugin",
      version: "1.0.0",
      components: { skills: ["./skills"] },
    });

    const result = await validateNativePlugin(root);
    expect(result.status).toBe("valid");
    expect(result.plugin?.manifest.id).toBe("dev.vykor.valid");
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    ["missing manifest", undefined, "native_manifest_missing"],
    ["broken JSON", "{", "native_manifest_invalid_json"],
  ])("returns a structured diagnostic for %s", async (_label, content, code) => {
    if (content !== undefined) {
      await mkdir(join(root, ".vykor-plugin"));
      await writeFile(join(root, ".vykor-plugin", "plugin.json"), content);
    }
    const result = await validateNativePlugin(root);
    expect(result.status).toBe("invalid");
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });

  it("reports schema errors, missing components, and duplicate canonical sources", async () => {
    await mkdir(join(root, "skills"));
    await writeManifest({
      schemaVersion: 1,
      id: "dev.vykor.invalid",
      name: "invalid-plugin",
      version: "1.0.0",
      components: { skills: ["./skills", "./skills"], agents: ["./missing-agents"] },
    });

    const result = await validateNativePlugin(root);
    expect(result.status).toBe("invalid");
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["component_source_duplicate", "component_path_missing"]),
    );
  });

  it("reports a path-boundary violation as a diagnostic instead of throwing", async () => {
    await writeManifest({
      schemaVersion: 1,
      id: "dev.vykor.escape",
      name: "escape-plugin",
      version: "1.0.0",
      components: { skills: ["./../outside"] },
    });
    const result = await validateNativePlugin(root);
    expect(result.status).toBe("invalid");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "component_path_outside_root" })]),
    );
  });
});
