import test from "node:test"
import assert from "node:assert/strict"
import { validateDesktopWorkspaceImport } from "../verify-workspace-boundaries.mjs"
test("uses the public client and restricts local process management to main", () => {
 assert.equal(validateDesktopWorkspaceImport("src/main/feature.ts", "@rzx/client"), null)
 assert.equal(validateDesktopWorkspaceImport("src/main/feature.ts", "@rzx/client/service"), null)
 for (const directory of ["renderer", "shared", "preload"]) {
   assert.match(validateDesktopWorkspaceImport(`src/${directory}/feature.ts`, "@rzx/client/service"), /only allowed in main/)
 }
 assert.match(validateDesktopWorkspaceImport("src/main/feature.ts", "@rzx/client/internal"), /not allowed/)
})
test("allows only the main process to use the public data-root path leaf", () => {
 assert.equal(validateDesktopWorkspaceImport("src/main/feature.ts", "@vykor/host-config/paths"), null)
 for (const directory of ["renderer", "shared", "preload"]) assert.match(validateDesktopWorkspaceImport(`src/${directory}/feature.ts`, "@vykor/host-config/paths"), /only allowed in main/)
 for (const specifier of ["@vykor/host-config", "@vykor/host-config/internal", "@vykor/host-config/paths/private"]) assert.match(validateDesktopWorkspaceImport("src/main/feature.ts", specifier), /not allowed/)
})
test("keeps the trusted migration validation entry in main and rejects private subpaths", () => {
 assert.equal(validateDesktopWorkspaceImport("src/main/index.ts", "@vykor/server/migration-validation"), null)
 for (const directory of ["renderer", "shared", "preload"]) assert.match(validateDesktopWorkspaceImport(`src/${directory}/feature.ts`, "@vykor/server/migration-validation"), /only allowed in main/)
 assert.match(validateDesktopWorkspaceImport("src/main/index.ts", "@vykor/server/migration-validation/internal"), /not allowed/)
})

test("allows protocol data throughout Desktop and keeps admin requests in main", () => {
 for (const directory of ["renderer", "shared", "preload"]) {
   assert.equal(validateDesktopWorkspaceImport(`src/${directory}/feature.ts`, "@vykor/protocol"), null)
   assert.match(validateDesktopWorkspaceImport(`src/${directory}/feature.ts`, "@vykor/daemon-admin/plugins"), /only allowed in main/)
 }
 for (const feature of ["configuration", "knowledge", "workspace", "channels", "mcp", "plugins"]) {
   assert.equal(validateDesktopWorkspaceImport("src/main/feature.ts", `@vykor/daemon-admin/${feature}`), null)
 }
 assert.match(validateDesktopWorkspaceImport("src/main/feature.ts", "@vykor/daemon-admin"), /not allowed/)
 assert.match(validateDesktopWorkspaceImport("src/main/feature.ts", "@vykor/daemon-admin/plugins/private"), /not allowed/)
})

test("rejects the retired application client and its subpaths throughout Desktop", () => {
  for (const directory of ["main", "renderer", "shared", "preload"]) {
    for (const specifier of ["@vykor/application-client", "@vykor/application-client/service"]) {
      assert.match(validateDesktopWorkspaceImport(`src/${directory}/feature.ts`, specifier), /not allowed/)
    }
  }
})

test("keeps local note storage in main and rejects the service package root", () => {
 assert.equal(validateDesktopWorkspaceImport("src/main/feature.ts", "@vykor/services/notes"), null)
 for (const directory of ["renderer", "shared", "preload"]) {
   assert.match(validateDesktopWorkspaceImport(`src/${directory}/feature.ts`, "@vykor/services/notes"), /only allowed in main/)
 }
 assert.match(validateDesktopWorkspaceImport("src/main/feature.ts", "@vykor/services"), /not allowed/)
})
