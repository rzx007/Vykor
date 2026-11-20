import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkModuleDependency } from "../architecture-policy.mjs";
const policy = JSON.parse(readFileSync(new URL("../architecture-policy.json", import.meta.url), "utf8"));

test("user-data consumers can import Node paths without gaining access to settings implementations", () => {
  for (const fromFile of ["packages/personalization/src/index.ts", "packages/output-styles/src/index.ts", "packages/skills/src/index.ts", "apps/frontend/src/services/frecency.ts"]) {
    const input = { fromFile, specifier: "@vykor/host-config/paths", resolvedFile: "packages/host-config/src/storage/paths.ts", importedNames: ["getDataRoot"] };
    assert.deepEqual(checkModuleDependency(input, policy), []);
    for (const resolvedFile of ["packages/host-config/src/index.ts", "packages/host-config/src/settings/settings.ts"]) {
      assert.ok(checkModuleDependency({ ...input, specifier: "@vykor/host-config", resolvedFile }, policy).length);
    }
  }
  for (const fromFile of ["packages/client/src/index.ts", "packages/agent-contracts/src/index.ts", "packages/coordinator/src/index.ts"]) {
    assert.ok(checkModuleDependency({ fromFile, specifier: "@vykor/host-config/paths", resolvedFile: "packages/host-config/src/storage/paths.ts", importedNames: ["getDataRoot"] }, policy).length);
  }
});
