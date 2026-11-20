import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkModuleDependency } from "../architecture-policy.mjs";
const policy = JSON.parse(readFileSync(new URL("../architecture-policy.json", import.meta.url), "utf8"));
const input = {
  fromFile: "packages/client/src/service/registry.ts",
  specifier: "@vykor/host-config/paths",
  resolvedFile: "packages/host-config/src/storage/paths.ts",
  importedNames: ["resolveDataRootSelection"],
};
test("Node SDK discovery may use only the lightweight host path entry", () => {
  assert.deepEqual(checkModuleDependency(input, policy), []);
  assert.ok(checkModuleDependency({ ...input, specifier: "@vykor/host-config", resolvedFile: "packages/host-config/src/index.ts" }, policy).length);
  assert.ok(checkModuleDependency({ ...input, specifier: "@vykor/host-config/settings", resolvedFile: "packages/host-config/src/settings/settings.ts" }, policy).length);
});
test("Node SDK root admission allows only the exact writer and path-validation leaves", () => {
  const fromFile = "packages/client/src/service/service.ts";
  for (const [resolvedFile, name] of [
    ["packages/host-config/src/storage/data-root-writers.ts", "acquireDataRootWriter"],
    ["packages/host-config/src/storage/managed-path-relocation.ts", "isCompleteAbsolutePath"],
  ]) {
    assert.deepEqual(checkModuleDependency({ ...input, fromFile, resolvedFile, importedNames: [name], declarationOrigin: true }, policy), []);
    assert.ok(checkModuleDependency({ ...input, fromFile: "packages/client/src/transport/http-client.ts", resolvedFile, importedNames: [name], declarationOrigin: true }, policy).length);
  }
  for (const resolvedFile of [
    "packages/host-config/src/storage/managed-path-map.ts",
    "packages/host-config/src/settings/settings.ts",
    "packages/host-config/src/storage/new-runtime.ts",
  ]) assert.ok(checkModuleDependency({ ...input, fromFile, resolvedFile, declarationOrigin: true }, policy).length);
});
test("browser client modules cannot import the Node root-selection leaf or node builtins", () => {
  for (const fromFile of ["packages/client/src/index.ts", "packages/client/src/transport/http-client.ts", "packages/client/src/resources/sessions.ts"]) {
    assert.ok(checkModuleDependency({ ...input, fromFile }, policy).length);
    assert.ok(checkModuleDependency({ fromFile, specifier: "node:fs", importedNames: ["readFileSync"] }, policy).length);
  }
  assert.ok(checkModuleDependency({ ...input, fromFile: "packages/client/src/future-feature/new.ts" }, policy).length);
});
