import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkImportBoundary,
  extractImports,
  checkPackageDependency,
  countLegacyCalls,
  validateLegacyBaseline,
  checkSessionRunEngineComposition,
  checkMaintenanceCapability,
  checkAttachmentLayout,
  collectAttachmentLayoutErrors,
  findDependencyCycles,
  collectWorkspaceCycleErrors,
} from "./architecture-boundaries.mjs";

test("services cannot depend on server", () => {
  assert.deepEqual(
    checkPackageDependency("@vykor/services", "@vykor/server"),
    ["@vykor/services must not depend on @vykor/server"],
  );
});
test("sessions, conversations, and runs cannot import server", () => {
  assert.deepEqual(
    checkImportBoundary("packages/services/src/sessions/session-repository.ts", "@vykor/server"),
    ["packages/services/src/sessions/session-repository.ts must not depend on @vykor/server"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/conversations/conversation-repository.ts", "@vykor/server"),
    ["packages/services/src/conversations/conversation-repository.ts must not depend on @vykor/server"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/runs/run-repository.ts", "@vykor/server"),
    ["packages/services/src/runs/run-repository.ts must not depend on @vykor/server"],
  );
});

test("database cannot depend on sessions, conversations, or runs", () => {
  assert.deepEqual(
    checkImportBoundary("packages/services/src/database/storage-context.ts", "../sessions/index.js"),
    ["packages/services/src/database/storage-context.ts must not depend on sessions"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/database/storage-context.ts", "../conversations/index.js"),
    ["packages/services/src/database/storage-context.ts must not depend on conversations"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/database/storage-context.ts", "../runs/index.js"),
    ["packages/services/src/database/storage-context.ts must not depend on runs"],
  );
});

test("repositories cannot import session-runtime/store", () => {
  assert.deepEqual(
    checkImportBoundary("packages/services/src/sessions/session-repository.ts", "../session-runtime/store.js"),
    ["packages/services/src/sessions/session-repository.ts must not depend on session-runtime/store"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/conversations/conversation-repository.ts", "../session-runtime/store.js"),
    ["packages/services/src/conversations/conversation-repository.ts must not depend on session-runtime/store"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/runs/run-repository.ts", "../session-runtime/store.js"),
    ["packages/services/src/runs/run-repository.ts must not depend on session-runtime/store"],
  );
});

test("allowed imports return no errors", () => {
  assert.deepEqual(
    checkImportBoundary("packages/services/src/sessions/session-repository.ts", "../database/storage-context.js"),
    [],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/sessions/session-repository.ts", "../session-runtime/store-state.js"),
    [],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/database/storage-context.ts", "./session-database.js"),
    [],
  );
});

test("legacy SessionStore calls may decrease but not increase", () => {
  assert.deepEqual(
    validateLegacyBaseline(
      { sessionStoreFlatCalls: 8 },
      { sessionStoreFlatCalls: 7 },
    ),
    [],
  );
  assert.match(
    validateLegacyBaseline(
      { sessionStoreFlatCalls: 8 },
      { sessionStoreFlatCalls: 9 },
    )[0],
    /sessionStoreFlatCalls increased from 8 to 9/,
  );
});

test("counts direct legacy store calls with file locations", () => {
  assert.deepEqual(
    countLegacyCalls("context.store.createRun();\nstore.listProjects()", "demo.ts"),
    [
      { file: "demo.ts", line: 1, name: "createRun" },
      { file: "demo.ts", line: 2, name: "listProjects" },
    ],
  );
});

test("server routes cannot import SessionStore or repositories", () => {
  assert.deepEqual(
    checkImportBoundary("packages/server/src/http/routes/sessions.ts", "../../../services/src/session-runtime/store.js"),
    ["packages/server/src/http/routes/sessions.ts must not depend on SessionStore"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/server/src/http/routes/sessions.ts", "@vykor/services/sessions"),
    ["packages/server/src/http/routes/sessions.ts must not depend on session repository"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/server/src/http/routes/sessions.ts", "../../../services/src/conversations/conversation-repository.js"),
    ["packages/server/src/http/routes/sessions.ts must not depend on conversation repository"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/server/src/http/routes/sessions.ts", "../../../services/src/runs/run-repository.js"),
    ["packages/server/src/http/routes/sessions.ts must not depend on run repository"],
  );
});

test("application services cannot import DaemonApplication", () => {
  assert.deepEqual(
    checkImportBoundary("packages/server/src/application/session/session-interaction-service.ts", "../daemon-application.js"),
    ["packages/server/src/application/session/session-interaction-service.ts must not depend on DaemonApplication"],
  );
});

test("runtime cannot import http routes", () => {
  assert.deepEqual(
    checkImportBoundary("packages/server/src/runtime/run-coordinator.ts", "../http/routes/sessions.js"),
    ["packages/server/src/runtime/run-coordinator.ts must not depend on http/routes"],
  );
});

test("session command service cannot import HTTP or Daemon", () => {
  assert.deepEqual(
    checkImportBoundary("packages/server/src/application/session/session-command-service.ts", "../../http/routes/session.js"),
    ["packages/server/src/application/session/session-command-service.ts must not depend on http"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/server/src/application/session/session-command-service.ts", "../daemon-application.js"),
    ["packages/server/src/application/session/session-command-service.ts must not depend on Daemon"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/server/src/application/session/session-command-service.ts", "../../daemon/scheduled-task-service.js"),
    ["packages/server/src/application/session/session-command-service.ts must not depend on Daemon"],
  );
});

test("session query service cannot import runtime", () => {
  assert.deepEqual(
    checkImportBoundary("packages/server/src/application/session/session-query-service.ts", "../../runtime/session-run-engine.js"),
    ["packages/server/src/application/session/session-query-service.ts must not depend on runtime"],
  );
});

test("run admission and control services keep their stage 4C boundaries", () => {
  assert.deepEqual(
    checkImportBoundary("packages/server/src/application/session/run-admission-service.ts", "../../http/routes/sessions.js"),
    ["packages/server/src/application/session/run-admission-service.ts must not depend on http or Daemon"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/server/src/application/session/run-control-service.ts", "./session-run-executor.js"),
    ["packages/server/src/application/session/run-control-service.ts must not depend on SessionRunExecutor"],
  );
});

test("SessionRunEngine construction cannot regain admission or control facades", () => {
  assert.deepEqual(
    checkSessionRunEngineComposition("new SessionRunEngine({ store })", "packages/server/src/application/daemon-application.ts"),
    [],
  );
  assert.deepEqual(
    checkSessionRunEngineComposition("new SessionRunEngine({ admission: sharedAdmission, control: sharedControl })", "packages/server/src/application/daemon-application.ts"),
    ["packages/server/src/application/daemon-application.ts must not inject admission or control facades into SessionRunEngine"],
  );
});

test("maintenance services cannot hold a full SessionStore", () => {
  assert.deepEqual(
    checkMaintenanceCapability("interface Context { data: SessionStore; }", "session-maintenance-service.ts"),
    ["session-maintenance-service.ts must use a narrow maintenance capability instead of SessionStore"],
  );
  assert.deepEqual(
    checkMaintenanceCapability("interface Context { data: Pick<SessionStore, 'getSession'>; }", "session-maintenance-service.ts"),
    [],
  );
});

test("client resources cannot import VykorClient or Server", () => {
  assert.deepEqual(
    checkImportBoundary("packages/client/src/resources/session-resource.ts", "../transport/http-client.js"),
    ["packages/client/src/resources/session-resource.ts must not depend on VykorClient or Server"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/client/src/resources/session-resource.ts", "@vykor/server"),
    ["packages/client/src/resources/session-resource.ts must not depend on VykorClient or Server"],
  );
});

test("client transport cannot import resources", () => {
  assert.deepEqual(
    checkImportBoundary("packages/client/src/transport/http-transport.ts", "../resources/session-resource.js"),
    ["packages/client/src/transport/http-transport.ts must not depend on Resource"],
  );
});

test("frontend cannot import electron or desktop", () => {
  assert.deepEqual(
    checkImportBoundary("apps/frontend/src/hooks/useServerSync.ts", "electron"),
    ["apps/frontend/src/hooks/useServerSync.ts must not depend on Electron"],
  );
  assert.deepEqual(
    checkImportBoundary("apps/frontend/src/hooks/useServerSync.ts", "@vykor/desktop"),
    ["apps/frontend/src/hooks/useServerSync.ts must not depend on Desktop"],
  );
  assert.deepEqual(
    checkImportBoundary("apps/frontend/src/hooks/useServerSync.ts", "@vykor/client"),
    [],
  );
  assert.deepEqual(
    checkImportBoundary("apps/frontend/src/hooks/useServerSync.ts", "../../../desktop/src/main/session-service.js"),
    ["apps/frontend/src/hooks/useServerSync.ts must not depend on Desktop"],
  );
});

test("desktop renderer cannot import desktop main", () => {
  assert.deepEqual(
    checkImportBoundary("apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts", "../../main/session-service.js"),
    ["apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts must not depend on Desktop main"],
  );
});

test("desktop main cannot import desktop renderer", () => {
  assert.deepEqual(
    checkImportBoundary("apps/desktop/src/main/features/session/session-service.ts", "../../renderer/src/stores/desktop-session.js"),
    ["apps/desktop/src/main/features/session/session-service.ts must not depend on Desktop renderer"],
  );
});

test("retired attachment layouts are rejected", () => {
  assert.deepEqual(
    checkAttachmentLayout("packages/services/src/attachment/attachment-blob-store.ts", "export class AttachmentBlobStore {}"),
    ["packages/services/src/attachment/attachment-blob-store.ts uses a retired Services attachment root"],
  );
  assert.deepEqual(
    checkAttachmentLayout(
      "packages/server/src/application/attachment-resource/session-attachment-resources.ts",
      "export class SessionAttachmentResources {}",
    ),
    ["packages/server/src/application/attachment-resource/session-attachment-resources.ts uses a retired Server attachment root"],
  );
  assert.deepEqual(
    checkAttachmentLayout(
      "packages/server/src/application/attachments/attachment-service.ts",
      "export class AttachmentApplicationService {}",
    ),
    ["AttachmentApplicationService is retired; use Server AttachmentService"],
  );
  assert.deepEqual(
    checkAttachmentLayout(
      "packages/services/src/attachments/storage/attachment-blob-store.ts",
      "export class AttachmentService {}",
    ),
    [],
  );
});

test("attachment layout scan covers package root barrels", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "vykor-attachment-boundary-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  const servicesSource = join(fixtureRoot, "packages", "services", "src");
  mkdirSync(servicesSource, { recursive: true });
  writeFileSync(
    join(servicesSource, "index.ts"),
    'export { AttachmentService as AttachmentApplicationService } from "./attachments/index.js";\n',
  );

  assert.deepEqual(collectAttachmentLayoutErrors(fixtureRoot), [
    "AttachmentApplicationService is retired; use Server AttachmentService",
  ]);
});



test("dependency graph rejects direct, indirect, and self cycles", () => {
  assert.deepEqual(findDependencyCycles(new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]])), [["a", "b", "c", "a"]]);
  assert.deepEqual(findDependencyCycles(new Map([["a", ["a"]]])), [["a", "a"]]);
  assert.deepEqual(findDependencyCycles(new Map([["a", ["c"]], ["b", ["c"]], ["c", []]])), []);
});

test("workspace cycle checks include undeclared type imports and relative package imports", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "oh-package-cycles-"));
  try {
    for (const name of ["a", "b"]) {
      mkdirSync(join(fixtureRoot, "packages", name, "src"), { recursive: true });
      writeFileSync(join(fixtureRoot, "packages", name, "package.json"), JSON.stringify({ name: "@test/" + name }));
    }
    mkdirSync(join(fixtureRoot, "apps"));
    const a = join(fixtureRoot, "packages/a/src/index.ts");
    const b = join(fixtureRoot, "packages/b/src/index.ts");
    writeFileSync(a, 'import type { B } from "@test/b";');
    writeFileSync(b, 'export { A } from "../../a/src/index.js";');
    assert.deepEqual(collectWorkspaceCycleErrors(fixtureRoot), ["Workspace dependency cycle: @test/a -> @test/b -> @test/a"]);
    writeFileSync(b, 'import A = require("../../a");');
    assert.equal(collectWorkspaceCycleErrors(fixtureRoot).length, 1);
    writeFileSync(a, 'import "@test/b";\nimport { X } from "./local.js";');
    assert.equal(collectWorkspaceCycleErrors(fixtureRoot).length, 1);
    writeFileSync(a, '// import { B } from "@test/b";\nexport const A = "no dependency";');
    assert.deepEqual(collectWorkspaceCycleErrors(fixtureRoot), []);
    writeFileSync(a, 'import type { B } from "@test/b";');
    writeFileSync(b, 'export type B = string;');
    assert.deepEqual(collectWorkspaceCycleErrors(fixtureRoot), []);
    writeFileSync(join(fixtureRoot, "packages/b/package.json"), JSON.stringify({ name: "@test/b", dependencies: { "@test/a": "workspace:*" } }));
    assert.equal(collectWorkspaceCycleErrors(fixtureRoot).length, 1);
  } finally {
    assert.ok(fixtureRoot.startsWith(join(tmpdir(), "oh-package-cycles-")));
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});


test("import extraction follows syntax, including side effects, types, reexports, and dynamic imports", () => {
  const source = [
    'import "side-effect";',
    'import type { B } from "types";',
    'export { C } from "reexport";',
    'type D = import("inline-type").D;',
    'const mod = import("dynamic");',
    'const cjs = require("commonjs");',
    '// import { Fake } from "comment";',
    'const text = \'import "string-only";\';',
  ].join("\n");
  assert.deepEqual(extractImports(source), ["side-effect", "types", "reexport", "inline-type", "dynamic", "commonjs"]);
});


test("desktop boundary checks allow local styles but reject process aliases", () => {
  const renderer = "apps/desktop/src/renderer/src/main.tsx";
  const main = "apps/desktop/src/main/index.ts";
  assert.deepEqual(checkImportBoundary(renderer, "./assets/main.css"), []);
  assert.deepEqual(checkImportBoundary(main, "./assets/renderer.css"), []);
  assert.deepEqual(checkImportBoundary(renderer, "@main/features/session/session-service"), [renderer + " must not depend on Desktop main"]);
  assert.deepEqual(checkImportBoundary(main, "@renderer/stores/desktop-session/store"), [main + " must not depend on Desktop renderer"]);
});
