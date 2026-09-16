import assert from "node:assert/strict";
import test from "node:test";

import {
  checkImportBoundary,
  checkPackageDependency,
  countLegacyCalls,
  countClientLegacyCalls,
  validateLegacyBaseline,
  checkSessionRunEngineComposition,
  checkMaintenanceCapability,
} from "./architecture-boundaries.mjs";

test("services cannot depend on server", () => {
  assert.deepEqual(
    checkPackageDependency("@openharness/services", "@openharness/server"),
    ["@openharness/services must not depend on @openharness/server"],
  );
});

test("sessions, conversations, and runs cannot import server", () => {
  assert.deepEqual(
    checkImportBoundary("packages/services/src/sessions/session-repository.ts", "@openharness/server"),
    ["packages/services/src/sessions/session-repository.ts must not depend on @openharness/server"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/conversations/conversation-repository.ts", "@openharness/server"),
    ["packages/services/src/conversations/conversation-repository.ts must not depend on @openharness/server"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/services/src/runs/run-repository.ts", "@openharness/server"),
    ["packages/services/src/runs/run-repository.ts must not depend on @openharness/server"],
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

test("counts every direct client facade call with file locations", () => {
  assert.deepEqual(
    countClientLegacyCalls("client.getSettings();\nclient.sessions.getState('s1');\nclient.replyPermission();", "client.ts"),
    [
      { file: "client.ts", line: 1, name: "getSettings" },
      { file: "client.ts", line: 3, name: "replyPermission" },
    ],
  );
});

test("server routes cannot import SessionStore or repositories", () => {
  assert.deepEqual(
    checkImportBoundary("packages/server/src/http/routes/sessions.ts", "../../../services/src/session-runtime/store.js"),
    ["packages/server/src/http/routes/sessions.ts must not depend on SessionStore"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/server/src/http/routes/sessions.ts", "@openharness/services/sessions"),
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
    checkImportBoundary("packages/server/src/application/session/session-application-service.ts", "../daemon-application.js"),
    ["packages/server/src/application/session/session-application-service.ts must not depend on DaemonApplication"],
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

test("production SessionRunEngine construction requires both shared services", () => {
  assert.deepEqual(
    checkSessionRunEngineComposition("new SessionRunEngine({ store })", "packages/server/src/application/daemon-application.ts"),
    ["packages/server/src/application/daemon-application.ts must inject shared admission and control services"],
  );
  assert.deepEqual(
    checkSessionRunEngineComposition("new SessionRunEngine({ admission: sharedAdmission, control: sharedControl })", "packages/server/src/application/daemon-application.ts"),
    [],
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

test("client resources cannot import OpenHarnessClient or Server", () => {
  assert.deepEqual(
    checkImportBoundary("packages/client/src/resources/session-resource.ts", "../transport/http-client.js"),
    ["packages/client/src/resources/session-resource.ts must not depend on OpenHarnessClient or Server"],
  );
  assert.deepEqual(
    checkImportBoundary("packages/client/src/resources/session-resource.ts", "@openharness/server"),
    ["packages/client/src/resources/session-resource.ts must not depend on OpenHarnessClient or Server"],
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
    checkImportBoundary("apps/frontend/src/hooks/useServerSync.ts", "@openharness/desktop"),
    ["apps/frontend/src/hooks/useServerSync.ts must not depend on Desktop"],
  );
  assert.deepEqual(
    checkImportBoundary("apps/frontend/src/hooks/useServerSync.ts", "@openharness/client"),
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

