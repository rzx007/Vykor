import { expect, it } from "vitest";
import { validatePluginAppManifest, validatePluginAppResourceContents } from "../validation.js";
import { copyPluginAppJson } from "../../runtime/runtime-data.js";

it("validates authoring data independently of installation and trims surface titles", () => {
  const value = { schemaVersion: 1, backends: [{ id: "b", kind: "native-tools", resources: [{ uri: "ui://p/page", entry: "./page.html" }], tools: [] }],
    surfaces: [{ id: "p", title: " Page ", backend: "b", resourceUri: "ui://p/page", availability: "session" }] };
  const result = validatePluginAppManifest(value);
  expect(result.ok && result.value.surfaces[0]?.title).toBe("Page");
  expect(value.surfaces[0]?.title).toBe(" Page ");
  expect(validatePluginAppManifest({ ...value, runtimeAuthority: true }).ok).toBe(false);
  expect(validatePluginAppManifest({ ...value, backends: [{ ...value.backends[0], toolPolicies: [{ tool: "save", maxArgumentsBytes: 0 }] }] }).ok).toBe(false);
});

it("preserves canonical base64 padding bits and aggregate decoded-byte limits", () => {
  const uri = "ui://p/page", limits = { htmlBytes: 10, resourceBytes: 4 };
  for (const blob of ["", "YQ==", "YWI=", "YWJj", "YWJjZA=="]) expect(validatePluginAppResourceContents({ contents: [{ uri, blob }] }, uri, limits).ok).toBe(true);
  for (const blob of ["YQ=", "YR==", "YWJ=", "Y===", "====", "YQ==YQ==", "YQ==\n"]) expect(validatePluginAppResourceContents({ contents: [{ uri, blob }] }, uri, limits)).toEqual({ ok: false, code: "plugin_app_resource_invalid_blob" });
  expect(validatePluginAppResourceContents({ contents: [{ uri, blob: "YWJj" }, { uri, blob: "YWI=" }] }, uri, limits)).toEqual({ ok: false, code: "plugin_app_resource_too_large" });
});

it("keeps plugin-specific copy errors and the fixed object depth boundary", () => {
  const nested = (count: number): unknown => count ? { next: nested(count - 1) } : 0;
  expect(() => copyPluginAppJson(nested(32), 4096)).not.toThrow();
  expect(() => copyPluginAppJson(nested(33), 4096)).toThrow("plugin_app_invalid_json");
  expect(() => copyPluginAppJson({}, -1)).toThrow("plugin_app_invalid_json_limit");
  expect(() => copyPluginAppJson({ value: "文" }, 5)).toThrow("plugin_app_json_too_large");
});

it("does not allow malformed effective limits to disable resource bounds", () => {
  const result = { contents: [{ uri: "ui://p/page", text: "x" }] };
  expect(validatePluginAppResourceContents(result, "ui://p/page", { htmlBytes: 10, resourceBytes: NaN })).toEqual({ ok: false, code: "plugin_app_resource_invalid_limit" });
});
