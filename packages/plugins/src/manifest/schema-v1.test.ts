import { describe, expect, it } from "vitest";
import { OpenHarnessPluginManifestV1Schema } from "./schema-v1.js";

const validManifest = {
  schemaVersion: 1,
  id: "dev.openharness.example",
  name: "example-plugin",
  version: "1.0.0",
  components: { skills: ["./skills"] },
};

describe("OpenHarnessPluginManifestV1Schema", () => {
  it("accepts a minimal Native Plugin v1 manifest", () => {
    expect(OpenHarnessPluginManifestV1Schema.parse(validManifest)).toEqual(validManifest);
  });

  it.each([
    [{ ...validManifest, schemaVersion: 2 }, "schemaVersion"],
    [{ ...validManifest, id: "single" }, "id"],
    [{ ...validManifest, name: "Example Plugin" }, "name"],
    [{ ...validManifest, version: "" }, "version"],
    [{ ...validManifest, components: {} }, "components"],
    [{ ...validManifest, components: { skills: ["skills"] } }, "component path"],
    [{ ...validManifest, executable: "./index.js" }, "unknown top-level field"],
    [{ ...validManifest, compatibility: { environmentAliases: ["CLAUDE_PLUGIN_ROOT"] } }, "compatibility"],
  ])("rejects invalid input: %s (%s)", (input) => {
    expect(OpenHarnessPluginManifestV1Schema.safeParse(input).success).toBe(false);
  });

  it("keeps descriptive extensions inside metadata", () => {
    const input = { ...validManifest, metadata: { homepage: "https://example.test", xVendor: 1 } };
    expect(OpenHarnessPluginManifestV1Schema.parse(input).metadata).toEqual(input.metadata);
  });

  it("recognizes string and configured Native Tool declarations", () => {
    const input = {
      ...validManifest,
      components: {
        tools: [
          "./tools/simple.js",
          { entry: "./tools/configured.js", runtime: "node", permissions: ["process.spawn"] },
        ],
      },
    };
    expect(OpenHarnessPluginManifestV1Schema.safeParse(input).success).toBe(true);
  });
});
