import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readForbiddenSurfaces,
  scanForbiddenSurfaces,
} from "./forbidden-compatibility-surfaces.mjs";

test("the frozen Client method set is complete and unique", () => {
  const surfaces = readForbiddenSurfaces();
  assert.equal(surfaces.clientMethods.length, 118);
  assert.equal(new Set(surfaces.clientMethods).size, 118);
});

test("the compile-time negative fixture checks every removed method exactly once", () => {
  const surfaces = readForbiddenSurfaces();
  const fixture = readFileSync(new URL("../tests/client-public-api/consumer.ts", import.meta.url), "utf8");
  for (const name of surfaces.clientMethods) {
    assert.equal(fixture.match(new RegExp(`\\bclient\\.${name}\\b`, "g"))?.length, 1, name);
  }
});

test("reports a removed Client method used by production code", () => {
  const cwd = mkdtempSync(join(tmpdir(), "openharness-forbidden-"));
  try {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "demo.ts"), 'await client.getSession("s1");\n');
    const errors = scanForbiddenSurfaces({
      cwd,
      roots: ["src"],
      surfaces: {
        version: 1,
        clientMethods: ["getSession"],
        runtimeExports: [],
        httpRoutes: [],
        cliCommands: [],
        cliOptions: [],
        environmentVariables: [],
        configFields: [],
        enumValues: [],
        schemaNames: [],
      },
    });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].surface, "client-method/getSession");
    assert.equal(errors[0].file, "src/demo.ts");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("does not scan the forbidden manifest itself", () => {
  const cwd = mkdtempSync(join(tmpdir(), "openharness-forbidden-"));
  try {
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(
      join(cwd, "scripts", "forbidden-compatibility-surfaces.json"),
      JSON.stringify({ clientMethods: ["getSession"] }),
    );
    const errors = scanForbiddenSurfaces({
      cwd,
      roots: ["scripts"],
      surfaces: {
        version: 1,
        clientMethods: ["getSession"],
        runtimeExports: [],
        httpRoutes: [],
        cliCommands: [],
        cliOptions: [],
        environmentVariables: [],
        configFields: [],
        enumValues: [],
        schemaNames: [],
      },
    });
    assert.deepEqual(errors, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
