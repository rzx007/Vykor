import { describe, expect, it } from "vitest";
import { PluginUiManifestV1Schema } from "./ui-schema.js";

const component = {
  id: "findings", title: "检查结果", entry: "./ui/findings.html",
  surfaces: ["tool-result"], actions: [],
};
const manifest = { schemaVersion: 1, components: [component] };
const action = { id: "explain", label: "解释问题", tool: "TextInspectorExplain", completion: "keep-open" };

describe("PluginUiManifestV1Schema", () => {
  it("accepts presentation-only components and explicit actions", () => {
    expect(PluginUiManifestV1Schema.parse(manifest)).toEqual(manifest);
    expect(PluginUiManifestV1Schema.parse({ ...manifest,
      components: [{ ...component, actions: [action], surfaces: ["tool-result", "session-sidebar"] }],
    }).components[0]!.actions[0]).toEqual(action);
  });

  it.each([
    { ...manifest, schemaVersion: 2 },
    { ...manifest, executable: "./start.js" },
    { ...manifest, components: [] },
    { ...manifest, components: [component, component] },
    { ...manifest, components: [{ ...component, arbitrary: true }] },
    { ...manifest, components: [{ ...component, surfaces: [] }] },
    { ...manifest, components: [{ ...component, surfaces: ["global"] }] },
    { ...manifest, components: [{ ...component, surfaces: ["tool-result", "tool-result"] }] },
    { ...manifest, components: [{ ...component, entry: "https://example.invalid/app.html" }] },
    { ...manifest, components: [{ ...component, actions: undefined }] },
    { ...manifest, components: [{ ...component, actions: [action, action] }] },
    { ...manifest, components: [{ ...component, actions: [{ ...action, completion: undefined }] }] },
    { ...manifest, components: [{ ...component, actions: [{ ...action, inputSchema: {} }] }] },
    { ...manifest, components: [{ ...component, actions: [{ ...action, tool: " " }] }] },
    { ...manifest, components: [{ ...component, actions: [{ ...action, tool: " Tool " }] }] },
  ])("rejects invalid fields, versions, duplicate declarations and implicit behavior", value => {
    expect(PluginUiManifestV1Schema.safeParse(value).success).toBe(false);
  });

  it("enforces IDs, labels and component/action counts at their boundaries", () => {
    for (const id of ["", "Capital", "with.dot", "a".repeat(65)]) {
      expect(PluginUiManifestV1Schema.safeParse({ ...manifest, components: [{ ...component, id }] }).success).toBe(false);
    }
    expect(PluginUiManifestV1Schema.safeParse({ ...manifest,
      components: [{ ...component, id: "a".repeat(64), title: "😀".repeat(80) }],
    }).success).toBe(true);
    for (const title of ["", "  ", "😀".repeat(81)]) {
      expect(PluginUiManifestV1Schema.safeParse({ ...manifest, components: [{ ...component, title }] }).success).toBe(false);
    }
    const components = Array.from({ length: 16 }, (_, i) => ({ ...component, id: `component-${i}` }));
    expect(PluginUiManifestV1Schema.safeParse({ ...manifest, components }).success).toBe(true);
    expect(PluginUiManifestV1Schema.safeParse({ ...manifest, components: [...components, { ...component, id: "extra" }] }).success).toBe(false);
    const actions = Array.from({ length: 16 }, (_, i) => ({ ...action, id: `action-${i}` }));
    expect(PluginUiManifestV1Schema.safeParse({ ...manifest, components: [{ ...component, actions }] }).success).toBe(true);
    expect(PluginUiManifestV1Schema.safeParse({ ...manifest,
      components: [{ ...component, actions: [...actions, { ...action, id: "extra" }] }],
    }).success).toBe(false);
  });
});
