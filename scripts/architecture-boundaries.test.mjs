import assert from "node:assert/strict";
import test from "node:test";

import {
  checkImportBoundary,
  checkPackageDependency,
  countLegacyCalls,
  validateLegacyBaseline,
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
