import test from "node:test"
import assert from "node:assert/strict"
import { validateDesktopWorkspaceImport } from "../verify-workspace-boundaries.mjs"
test("allows only the main process to use the public data-root path leaf", () => {
 assert.equal(validateDesktopWorkspaceImport("src/main/feature.ts", "@vykor/host-config/paths"), null)
 for (const directory of ["renderer", "shared", "preload"]) assert.match(validateDesktopWorkspaceImport(`src/${directory}/feature.ts`, "@vykor/host-config/paths"), /only allowed in main/)
 for (const specifier of ["@vykor/host-config", "@vykor/host-config/internal", "@vykor/host-config/paths/private"]) assert.match(validateDesktopWorkspaceImport("src/main/feature.ts", specifier), /not allowed/)
})
