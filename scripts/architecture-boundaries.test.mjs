import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  checkModuleDependency,
  collectPolicyViolations,
  collectArchitecturePolicyErrors,
  extractModuleDependencies,
  moduleViolations,
  validateArchitecturePolicy,
} from "./architecture-policy.mjs";

const targetPolicy = JSON.parse(readFileSync(new URL("./architecture-policy.json", import.meta.url), "utf8"));
const policySchema = JSON.parse(readFileSync(new URL("./architecture-policy.schema.json", import.meta.url), "utf8"));
const strictPolicy = () => ({ ...structuredClone(targetPolicy), stageExceptions: [] });

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

test("target policy and exact exception deadlines satisfy the committed schema", () => {
  assert.deepEqual(validateArchitecturePolicy(targetPolicy, policySchema), []);
  const wildcard = strictPolicy();
  wildcard.stageExceptions.push({ fromFile: "packages/**/src/*", target: "x", reason: "bad", removeByPhase: "P4", migrationId: "M18" });
  assert.ok(validateArchitecturePolicy(wildcard, policySchema).length > 0);
  const expired = strictPolicy();
  expired.currentPhase = "P4";
  expired.stageExceptions.push({ fromFile: "packages/core/src/index.ts", target: "x", reason: "legacy", removeByPhase: "P4", migrationId: "M18" });
  assert.match(validateArchitecturePolicy(expired, policySchema).join("\n"), /Expired/);
  const extra = strictPolicy();
  extra.skipChecks = true;
  assert.match(validateArchitecturePolicy(extra, policySchema).join("\n"), /unknown skipChecks/);
});

test("Kernel rejects Node subentries, relative paths, type imports and outside-workspace detours", () => {
  for (const input of [
    { specifier: "../node/index.js", resolvedFile: "packages/agent-runtime/src/node/index.ts" },
    { specifier: "@vykor/agent-runtime/node", resolvedFile: "packages/agent-runtime/src/node/index.ts", typeOnly: true },
    { specifier: "../../../../tests/bridge.js", resolvedFile: "tests/bridge.ts" },
  ]) assert.ok(checkModuleDependency({ fromFile: "packages/agent-runtime/src/kernel/agent.ts", importedNames: ["Hidden"], ...input }, strictPolicy()).length > 0);
  assert.ok(checkModuleDependency({ fromFile: "packages/agent-runtime/src/kernel/agent.ts", specifier: "node:fs", importedNames: ["readFileSync"] }, strictPolicy()).length > 0);
  assert.ok(checkModuleDependency({ fromFile: "packages/agent-runtime/src/kernel-entry.ts", specifier: "./node/index.js", resolvedFile: "packages/agent-runtime/src/node/index.ts", importedNames: ["Hidden"] }, strictPolicy()).length > 0);
  assert.deepEqual(checkModuleDependency({ fromFile: "packages/agent-runtime/src/kernel/agent.ts", specifier: "@vykor/agent-contracts", importedNames: ["AgentRunScope"], typeOnly: true,
    resolvedFile: "packages/agent-contracts/src/execution.ts" }, strictPolicy()), []);
});

test("routes cannot hide SessionStore or repositories in the services root or import aliases", () => {
  for (const name of ["SessionStore", "NoteRepository", "ConversationRepository"]) assert.ok(checkModuleDependency({
    fromFile: "packages/server/src/http/routes/new-feature.ts", specifier: "@vykor/services", importedNames: [name], typeOnly: true,
  }, strictPolicy()).length > 0);
  assert.deepEqual(checkModuleDependency({ fromFile: "packages/server/src/http/routes/new-feature.ts", specifier: "@vykor/protocol", importedNames: ["SessionRecord"], typeOnly: true,
    resolvedFile: "packages/protocol/src/session.ts" }, strictPolicy()), []);
});

test("AST extraction ignores text and follows named aliases, types, namespaces and require", () => {
  const dependencies = extractModuleDependencies([
    'import type { SessionStore as Hidden } from "@vykor/services";',
    'export { Hidden as Public } from "./bridge.js";',
    'export type * from "./types.js";',
    'type Inline = import("@vykor/services").SessionStore;',
    'const { SessionStore: Store } = await import("@vykor/services");',
    'const cjs = require("./node.cjs");',
    'import legacy = require("./legacy.cjs");',
    '// import { Fake } from "not-code";',
    'const text = \'import("not-code")\';',
  ].join("\n"));
  assert.equal(dependencies.filter((item) => item.importedNames.includes("SessionStore")).length, 3);
  assert.ok(dependencies.some((item) => item.specifier === "./types.js" && item.typeOnly));
  assert.ok(dependencies.some((item) => item.specifier === "./legacy.cjs"));
  assert.ok(dependencies.every((item) => item.specifier !== "not-code"));
});

function policyFixture(files, run) {
  const directory = mkdtempSync(join(tmpdir(), "vykor-architecture-policy-"));
  const write = (file, content) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), content);
  };
  try {
    for (const name of ["agent-runtime", "services", "server", "protocol"]) write(`packages/${name}/package.json`, JSON.stringify({ name: `@vykor/${name}`, exports: { ".": "./src/index.ts" } }));
    for (const [file, content] of Object.entries(files)) write(file, content);
    return run(directory, write);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "vykor-architecture-policy-")));
    rmSync(directory, { recursive: true, force: true });
  }
}

test("declaration origins expose renamed/star/local-import barrels and wrapped storage types", () => {
  for (const bridge of [
    'export { SessionStore as Hidden } from "@vykor/services";',
    'export * from "@vykor/services";',
    'import type { SessionStore as Store } from "@vykor/services"; export type { Store as Hidden };',
    'import type { SessionStore } from "@vykor/services"; export interface Hidden { store: SessionStore }',
    'export type Hidden = import("@vykor/services").SessionStore;',
    'import type { SessionStore as Storage } from "@vykor/services"; export type Hidden = Pick<Storage, "notes">;',
  ]) policyFixture({
    "packages/services/src/index.ts": 'export { SessionStore } from "./session-runtime/store.js";',
    "packages/services/src/session-runtime/store.ts": "export class SessionStore {}",
    "packages/server/src/bridge.ts": bridge,
    "packages/server/src/http/routes/new-feature.ts": 'import type { Hidden as PublicStore } from "../../bridge.js";',
  }, (directory) => {
    // Star exports retain the original exported name.
    const route = join(directory, "packages/server/src/http/routes/new-feature.ts");
    if (bridge.includes("export *")) writeFileSync(route, 'import type { SessionStore as PublicStore } from "../../bridge.js";');
    const violations = collectPolicyViolations(directory, strictPolicy());
    assert.ok(violations.some((item) => item.fromFile.endsWith("routes/new-feature.ts") && item.target.includes("SessionStore")), JSON.stringify(violations));
  });
});

test("namespace/dynamic imports, source-export cycles and TS path aliases cannot hide Node declarations", () => {
  policyFixture({
    "packages/agent-runtime/tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@hidden/*": ["src/node/*"] } } }),
    "packages/agent-runtime/tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
    "packages/agent-runtime/src/node/host.ts": "export interface HostSettings {}",
    "packages/agent-runtime/src/kernel/bridge.ts": 'export * from "./cycle.js"; export { HostSettings as Hidden } from "@hidden/host";',
    "packages/agent-runtime/src/kernel/cycle.ts": 'export * from "./bridge.js";',
    "packages/agent-runtime/src/kernel/index.ts": 'import type * as N from "./bridge.js"; const lazy = import("./bridge.js");',
  }, (directory) => {
    const violations = collectPolicyViolations(directory, strictPolicy());
    assert.ok(violations.some((item) => item.fromFile.endsWith("kernel/index.ts") && item.target.includes("src/node/host.ts")));
  });
});

test("exceptions match an exact file/target, expire, and cannot borrow another migration deadline", () => {
  const input = { fromFile: "packages/server/src/http/routes/old.ts", specifier: "@vykor/services", importedNames: ["SessionStore"], typeOnly: true };
  const policy = strictPolicy();
  policy.currentPhase = "P4";
  const item = moduleViolations(input, policy)[0];
  policy.stageExceptions = [{ fromFile: item.fromFile, target: item.target, reason: "Migrate existing route in P5", removeByPhase: item.removeByPhase, migrationId: item.migrationId }];
  assert.deepEqual(checkModuleDependency(input, policy), []);
  assert.ok(checkModuleDependency({ ...input, fromFile: "packages/server/src/http/routes/new.ts" }, policy).length > 0);
  assert.ok(checkModuleDependency({ ...input, importedNames: ["NoteRepository"] }, policy).length > 0);
  assert.ok(checkModuleDependency({ ...input, typeOnly: false }, policy).length > 0);
  policy.currentPhase = "P5";
  assert.ok(checkModuleDependency(input, policy).length > 0);
});

test("stale exceptions require removal and metadata must match the responsible rule", () => {
  policyFixture({ "packages/server/src/http/routes/old.ts": 'import type { SessionStore } from "@vykor/services";' }, (directory, write) => {
    const policy = strictPolicy();
    policy.currentPhase = "P4";
    policy.stageExceptions = collectPolicyViolations(directory, policy).map(({ fromFile, target, reason, removeByPhase, migrationId }) => ({ fromFile, target, reason, removeByPhase, migrationId }));
    assert.deepEqual(collectArchitecturePolicyErrors(directory, policy).errors, []);
    policy.stageExceptions[0].migrationId = "M01";
    assert.match(collectArchitecturePolicyErrors(directory, policy).errors.join("\n"), /mismatch/);
    write("packages/server/src/http/routes/old.ts", "export {};");
    assert.match(collectArchitecturePolicyErrors(directory, policy).errors.join("\n"), /Stale/);
  });
});

test("portable contracts reject Node, value environment imports, and external implementations", () => {
  for (const input of [
    { specifier: "node:fs", importedNames: ["readFileSync"] },
    { specifier: "zod", importedNames: ["z"] },
    { specifier: "@vykor/environment", importedNames: ["createWorkspaceBinding"] },
  ]) assert.ok(checkModuleDependency({ fromFile: "packages/agent-contracts/src/tools.ts", ...input }, strictPolicy()).length > 0);
  assert.deepEqual(checkModuleDependency({ fromFile: "packages/agent-contracts/src/tools.ts", specifier: "@vykor/environment", importedNames: ["ExecutionEnvironmentHandle"], typeOnly: true }, strictPolicy()), []);
});

test("shared type diamonds and export cycles preserve every forbidden origin", () => {
  policyFixture({}, (directory, write) => {
    write("packages/core/package.json", JSON.stringify({ name: "@vykor/core", exports: { ".": "./src/index.ts" } }));
    write("packages/agent-runtime/src/node/host.ts", "export interface Host { closed: boolean }\nexport interface OtherHost { closed: boolean }");
    write("packages/core/src/level0.ts", 'import type { Host, OtherHost } from "../../agent-runtime/src/node/host.js"; export interface Left0 { host: Host } export interface Right0 { host: OtherHost }');
    for (let level = 1; level <= 18; level++) write(`packages/core/src/level${level}.ts`, `import type { Left${level - 1}, Right${level - 1} } from "./level${level - 1}.js"; export interface Left${level} { left: Left${level - 1}; right: Right${level - 1} } export interface Right${level} { left: Left${level - 1}; right: Right${level - 1} }`);
    write("packages/core/src/index.ts", 'export type { Left18 as Root } from "./level18.js"; export * from "./cycle.js";');
    write("packages/core/src/cycle.ts", 'export * from "./index.js";');
    write("packages/agent-runtime/src/kernel/index.ts", 'import type { Root } from "@vykor/core"; export type Binding = Root;');
    const violations = collectPolicyViolations(directory, strictPolicy()).filter(item => item.fromFile.endsWith("kernel/index.ts"));
    assert.ok(violations.some(item => item.target.includes("Host") && item.target.includes("node/host.ts")));
    assert.ok(violations.some(item => item.target.includes("OtherHost") && item.target.includes("node/host.ts")));
  });
});

test("P1 foundation packages reject upward dependencies and config cannot depend on MCP runtime", () => {
  const policy = strictPolicy();
  for (const fromFile of ["packages/agent-contracts/src/messages.ts", "packages/host-config/src/settings.ts"]) {
    for (const specifier of ["@vykor/core", "@vykor/agent-runtime", "@vykor/mcp", "@vykor/server"]) {
      assert.ok(checkModuleDependency({ fromFile, specifier, importedNames: ["Settings"], typeOnly: true }, policy).length > 0);
    }
  }
  assert.deepEqual(checkModuleDependency({ fromFile: "packages/host-config/src/settings.ts", specifier: "@vykor/agent-contracts", importedNames: ["AgentChildBudget"], typeOnly: true }, policy), []);
  assert.ok(Number(policy.currentPhase.slice(1)) >= 1);
  assert.ok(targetPolicy.stageExceptions.every(item => item.removeByPhase !== "P1"));
});

test("P2 execution resources have no storage or engine dependency and retired imports are rejected", () => {
  const policy = strictPolicy();
  for (const specifier of ["@vykor/core", "@vykor/services", "@vykor/agent-runtime", "@vykor/server"]) {
    assert.ok(checkModuleDependency({ fromFile: "packages/execution-node/src/executions/runtime-owner.ts", specifier, importedNames: ["Host"], typeOnly: true }, policy).length > 0);
  }
  for (const specifier of ["@vykor/services/executions", "../../services/src/executions/index.js", "../../services/src/lsp/index.js"]) {
    assert.ok(checkModuleDependency({ fromFile: "packages/tools/src/search/lsp.ts", specifier, importedNames: ["LspClient"] }, policy).length > 0);
  }
  assert.deepEqual(checkModuleDependency({ fromFile: "packages/execution-node/src/executions/types.ts", specifier: "@vykor/agent-contracts", importedNames: ["AgentChildResult"], typeOnly: true }, policy), []);
  const services = JSON.parse(readFileSync(new URL("../packages/services/package.json", import.meta.url), "utf8"));
  assert.equal(services.exports["./executions"], undefined);
  assert.ok(targetPolicy.stageExceptions.every(item => !["P1", "P2"].includes(item.removeByPhase)));
});

test("P3 tools cannot import host implementations and coordinator entries stay pure", () => {
  const policy = strictPolicy();
  for (const specifier of ["@vykor/services", "@vykor/auth", "@vykor/mcp", "@vykor/skills", "@vykor/agent-runtime"]) {
    assert.ok(checkModuleDependency({ fromFile: "packages/tools/src/ports/workflow.ts", specifier, importedNames: ["Host"] }, policy).length > 0);
  }
  for (const specifier of ["node:fs", "node:child_process", "@vykor/host-config"]) {
    assert.ok(checkModuleDependency({ fromFile: "packages/coordinator/src/definitions/loader.ts", specifier, importedNames: ["read"] }, policy).length > 0);
  }
  assert.deepEqual(checkModuleDependency({ fromFile: "packages/coordinator/src/definitions/loader.ts", specifier: "yaml", importedNames: ["parse"] }, policy), []);
  assert.ok(checkModuleDependency({ fromFile: "packages/coordinator/src/workflow/runner.ts", specifier: "../teams/index.js", resolvedFile: "packages/coordinator/src/teams/index.ts", importedNames: ["TeamRegistry"] }, policy).length > 0);
  assert.ok(checkModuleDependency({ fromFile: "packages/coordinator/src/workflow/runner.ts", specifier: "node:child_process", importedNames: ["spawn"] }, policy).length > 0);
  assert.ok(checkModuleDependency({ fromFile: "packages/server/src/jobs/example.ts", specifier: "@vykor/coordinator/workflow/store", importedNames: ["runPersistentWorkflow"] }, policy).length > 0);
  assert.ok(checkModuleDependency({ fromFile: "packages/server/src/jobs/example.ts", specifier: "@vykor/tools/agent/child-task", importedNames: ["awaitFrameworkChildTask"] }, policy).length > 0);
  assert.ok(targetPolicy.stageExceptions.every(item => !["P1", "P2", "P3"].includes(item.removeByPhase)));
});

test("portable code permits Vitest only in test files",()=>{
 for(const prefix of ["packages/agent-contracts/src/","packages/agent-runtime/src/kernel/"]){
  assert.deepEqual(checkModuleDependency({fromFile:prefix+"scope.test.ts",specifier:"vitest",importedNames:["it"]},strictPolicy()),[]);
  assert.ok(checkModuleDependency({fromFile:prefix+"scope.ts",specifier:"vitest",importedNames:["it"]},strictPolicy()).length>0);
 }
});


test("P6 has no stage exceptions and Client directly depends only on Protocol", () => {
  assert.equal(targetPolicy.currentPhase, "P6");
  assert.deepEqual(targetPolicy.stageExceptions, []);
  assert.deepEqual(targetPolicy.packages["@vykor/client"].allowed, ["@vykor/protocol"]);
  const fromFile = "packages/client/src/resource.ts";
  for (const input of [
    { specifier: "@vykor/agent-contracts", importedNames: ["McpCallResultData"], typeOnly: true },
    { specifier: "../../agent-contracts/src/tool-data.js", resolvedFile: "packages/agent-contracts/src/tool-data.ts", importedNames: ["parseMcpCallResultData"] },
    { specifier: "@vykor/server", importedNames: ["Server"] },
  ]) assert.ok(checkModuleDependency({ fromFile, ...input }, strictPolicy()).length > 0);
  assert.deepEqual(checkModuleDependency({ fromFile, specifier: "@vykor/protocol", resolvedFile: "packages/agent-contracts/src/tool-data.ts", importedNames: ["parseMcpCallResultData"], declarationOrigin: true }, strictPolicy()), []);
});

test("Client may consume canonical data through Protocol but cannot import contracts through aliases", () => {
  policyFixture({
    "packages/client/package.json": JSON.stringify({ name: "@vykor/client" }),
    "packages/agent-contracts/package.json": JSON.stringify({ name: "@vykor/agent-contracts", exports: { ".": "./src/index.ts", "./tool-data": "./src/tool-data.ts" } }),
    "packages/agent-contracts/src/index.ts": 'export * from "./tool-data.js";',
    "packages/agent-contracts/src/tool-data.ts": "export interface McpCallResultData { content: unknown[] }; export function parseMcpCallResultData() {}",
    "packages/protocol/src/index.ts": 'export { parseMcpCallResultData, type McpCallResultData } from "@vykor/agent-contracts/tool-data";',
    "packages/client/src/index.ts": 'export { parseMcpCallResultData } from "@vykor/protocol"; import type { McpCallResultData } from "@vykor/protocol";',
  }, (directory, write) => {
    assert.deepEqual(collectPolicyViolations(directory, strictPolicy()), []);
    write("packages/client/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@hidden/contracts": ["../agent-contracts/src/index.ts"] } } }));
    write("packages/client/src/index.ts", 'export { parseMcpCallResultData } from "@hidden/contracts";');
    assert.ok(collectPolicyViolations(directory, strictPolicy()).some(item => item.fromFile.startsWith("packages/client/") && item.target.startsWith("package:")));
  });
});

test("Protocol can only consume the canonical data entry, including relative paths", () => {
  const fromFile = "packages/protocol/src/events.ts";
  for (const input of [
    { specifier: "@vykor/agent-contracts", importedNames: ["AgentRunHandle"], typeOnly: true },
    { specifier: "../../agent-contracts/src/execution.js", resolvedFile: "packages/agent-contracts/src/execution.ts", importedNames: ["AgentRunScope"], typeOnly: true },
  ]) assert.ok(checkModuleDependency({ fromFile, ...input }, strictPolicy()).length > 0);
  assert.deepEqual(checkModuleDependency({ fromFile, specifier: "@vykor/agent-contracts/tool-data", resolvedFile: "packages/agent-contracts/src/tool-data.ts", importedNames: ["McpCallResultData"], typeOnly: true }, strictPolicy()), []);
});

test("retired Kernel source paths cannot return as forwarding files", () => {
  for (const name of ["framework-agent-run", "event-source", "agent", "kernel", "runtime-builder"]) {
    assert.ok(checkModuleDependency({ fromFile: "apps/desktop/src/fixture.test.ts", specifier: `../../packages/agent-runtime/src/${name}` }, strictPolicy()).length > 0);
  }
  assert.deepEqual(checkModuleDependency({ fromFile: "packages/agent-runtime/src/index.ts", specifier: "./kernel/agent.js", resolvedFile: "packages/agent-runtime/src/kernel/agent.ts" }, strictPolicy()), []);
});

test("storage repositories and session runtime reject hosts, process execution, and model SDKs", () => {
  const rule = targetPolicy.modules.find(rule => rule.id === "storage-hosts");
  for (const prefix of rule.fromPaths) {
    const fromFile = prefix + "new-storage.ts";
    for (const specifier of ["@vykor/core", "@vykor/execution-node", "@vykor/memory", "@vykor/sandbox", "@vykor/server", "@vykor/client", "@vykor/tools", "@vykor/agent-runtime", "node-pty", "openai", "node:child_process"]) {
      assert.ok(checkModuleDependency({ fromFile, specifier, importedNames: ["Host"], typeOnly: true }, strictPolicy()).length > 0, fromFile + " -> " + specifier);
    }
    for (const resolvedFile of ["packages/services/src/office/index.ts", "packages/services/src/autodream/index.ts", "packages/services/src/memory-extract.ts", "packages/services/src/models/host.ts", "packages/services/src/terminal/pty.ts"]) {
      assert.ok(checkModuleDependency({ fromFile, specifier: "../hidden.js", resolvedFile, importedNames: ["Host"] }, strictPolicy()).length > 0, fromFile + " -> " + resolvedFile);
    }
    assert.deepEqual(checkModuleDependency({ fromFile, specifier: "../database/index.js", resolvedFile: "packages/services/src/database/index.ts", importedNames: ["StorageContext"], typeOnly: true }, strictPolicy()), []);
  }
});

test("storage declaration tracing rejects host types wrapped behind a local storage barrel", () => {
  policyFixture({
    "packages/services/src/office/host.ts": "export interface OfficeHost { execute(): void }",
    "packages/services/src/database/bridge.ts": 'import type { OfficeHost } from "../office/host.js"; export interface Hidden { host: OfficeHost }',
    "packages/services/src/session-runtime/new-store.ts": 'import type { Hidden } from "../database/bridge.js";',
  }, directory => {
    assert.ok(collectPolicyViolations(directory, strictPolicy()).some(item => item.fromFile.endsWith("session-runtime/new-store.ts") && item.target.includes("office/host.ts")));
  });
});
