import assert from "node:assert/strict";
import test from "node:test";

import {
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
