import { describe, expect, it } from "vitest";
import { PluginUiManifestSchema } from "./ui-schema.js";

const component = {
  id: "findings", title: "检查结果", entry: "./ui/findings.html",
  surface: "tool-result", actions: [],
};
const manifest = { schemaVersion: 2, components: [component] };
const action = { id: "explain", label: "解释问题", tool: "TextInspectorExplain", completion: "keep-open" };

describe("PluginUiManifestSchema", () => {
  it("accepts presentation-only components and explicit actions", () => {
    expect(PluginUiManifestSchema.parse(manifest)).toEqual(manifest);
    expect(PluginUiManifestSchema.parse({ ...manifest,
      components: [{ ...component, actions: [action], surface: "session-sidebar" }],
    }).components[0]!.actions[0]).toEqual(action);
  });

  it.each([
    { ...manifest, schemaVersion: 1 },
    { ...manifest, executable: "./start.js" },
    { ...manifest, components: [] },
    { ...manifest, components: [component, component] },
    { ...manifest, components: [{ ...component, arbitrary: true }] },
    { ...manifest, components: [{ ...component, surface: undefined }] },
    { ...manifest, components: [{ ...component, surface: "global" }] },
    { ...manifest, components: [{ ...component, surface: ["tool-result"] }] },
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
    expect(PluginUiManifestSchema.safeParse(value).success).toBe(false);
  });

  it("enforces IDs, labels and component/action counts at their boundaries", () => {
    for (const id of ["", "Capital", "with.dot", "a".repeat(65)]) {
      expect(PluginUiManifestSchema.safeParse({ ...manifest, components: [{ ...component, id }] }).success).toBe(false);
    }
    expect(PluginUiManifestSchema.safeParse({ ...manifest,
      components: [{ ...component, id: "a".repeat(64), title: "😀".repeat(80) }],
    }).success).toBe(true);
    for (const title of ["", "  ", "😀".repeat(81)]) {
      expect(PluginUiManifestSchema.safeParse({ ...manifest, components: [{ ...component, title }] }).success).toBe(false);
    }
    const components = Array.from({ length: 16 }, (_, i) => ({ ...component, id: `component-${i}` }));
    expect(PluginUiManifestSchema.safeParse({ ...manifest, components }).success).toBe(true);
    expect(PluginUiManifestSchema.safeParse({ ...manifest, components: [...components, { ...component, id: "extra" }] }).success).toBe(false);
    const actions = Array.from({ length: 16 }, (_, i) => ({ ...action, id: `action-${i}` }));
    expect(PluginUiManifestSchema.safeParse({ ...manifest, components: [{ ...component, actions }] }).success).toBe(true);
    expect(PluginUiManifestSchema.safeParse({ ...manifest,
      components: [{ ...component, actions: [...actions, { ...action, id: "extra" }] }],
    }).success).toBe(false);
  });
});
