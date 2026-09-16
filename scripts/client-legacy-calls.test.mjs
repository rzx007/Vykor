import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspaceScanConfigs, loadLegacyMethods, scanClientLegacyCalls } from "./client-legacy-calls.mjs";

test("identifies direct, alias, member, await-factory, destructure, type-index, value-ref and mapped Pick", () => {
  const source = `
import { OpenHarnessClient } from "@openharness/client";

declare const client: OpenHarnessClient;
declare function clientFactory(): Promise<OpenHarnessClient>;
class Host { client: OpenHarnessClient = client; }
const host = new Host();

// 1. direct
client.getSession("s1");

// 2. alias
const api = client;
api.listJobs();

// 3. member
host.client.replyPermission("p1", {} as any);

// 4. await-factory
(await clientFactory()).listPlugins({} as any);

// 5. destructure
const { getSession } = client;

// 6. type-index
type CancelResult = ReturnType<OpenHarnessClient["cancelJob"]>;

// 7. value-reference
const fn = client.getSession;

// 8. Pick mapped type
type Capability = Pick<OpenHarnessClient, "capabilities">;
declare const narrowed: Capability;
narrowed.capabilities();

// 9. Pick callback parameter
declare function invoke(callback: (c: Capability) => void): void;
invoke((c) => c.capabilities());

// 10. parameter destructure
function useDestructured({ getSession: get }: OpenHarnessClient) { return get("s2"); }

// 11. explicit mapped type
type ExplicitCapability = { [K in "getSession"]: OpenHarnessClient[K] };
declare const explicit: ExplicitCapability;
explicit.getSession("s3");

// negative: Resource call (should not report)
client.sessions.get("s1");

// negative: unrelated object with same method name (should not report)
const unrelated = { getSession(id: string) {} };
unrelated.getSession("s1");
`;

  const clientDts = `
export declare class OpenHarnessClient {
  sessions: { get(id: string): Promise<any> };
  getSession(id: string): Promise<any>;
  listJobs(): Promise<any>;
  replyPermission(id: string, input: any): Promise<any>;
  listPlugins(input: any): Promise<any>;
  cancelJob(): Promise<any>;
  capabilities(): Promise<any>;
}
`;

  const libDts = `
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
interface Promise<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2>;
}
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
`;

  const hostMap = new Map([
    ["/workspace/src/demo.ts", source],
    ["/workspace/node_modules/@openharness/client/index.d.ts", clientDts],
    ["/lib.d.ts", libDts],
  ]);

  const compilerHost = {
    getSourceFile(fileName) {
      const content = hostMap.get(fileName);
      if (content !== undefined) {
        return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
      }
      return undefined;
    },
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/workspace",
    getDirectories: () => [],
    fileExists: (f) => hostMap.has(f),
    readFile: (f) => hostMap.get(f),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };

  const program = ts.createProgram(
    ["/workspace/src/demo.ts"],
    {
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    compilerHost,
  );

  const compatMethods = new Map([
    ["getSession", "sessions.get"],
    ["listJobs", "jobs.list"],
    ["replyPermission", "permissions.reply"],
    ["listPlugins", "plugins.list"],
    ["cancelJob", "jobs.cancel"],
    ["capabilities", "protocol.capabilities"],
  ]);

  const result = scanClientLegacyCalls({
    cwd: "/workspace",
    compatMethods,
    programs: [
      {
        program,
        scanFiles: ["/workspace/src/demo.ts"],
      },
    ],
  });

  assert.equal(result.dynamicMembers.length, 0);
  assert.equal(result.unresolvedClientMembers.length, 0);

  const byMethod = (m) => result.references.filter((r) => r.method === m);

  // 1. direct getSession
  const getSessionCalls = byMethod("getSession").filter((r) => r.usage === "call");
  assert.equal(getSessionCalls.length, 2);
  assert.ok(getSessionCalls.every((call) => call.receiver === "direct"));
  assert.ok(getSessionCalls.every((call) => call.replacement === "sessions.get"));

  // 2. alias listJobs
  const listJobs = byMethod("listJobs");
  assert.equal(listJobs.length, 1);
  assert.equal(listJobs[0].receiver, "alias");
  assert.equal(listJobs[0].replacement, "jobs.list");

  // 3. member replyPermission
  const reply = byMethod("replyPermission");
  assert.equal(reply.length, 1);
  assert.equal(reply[0].receiver, "member");

  // 4. await-factory listPlugins
  const plugins = byMethod("listPlugins");
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].receiver, "await-factory");

  // 5. destructure getSession
  const destr = byMethod("getSession").filter(
    (r) => r.usage === "destructure" && r.receiver === "destructured",
  );
  assert.equal(destr.length, 1);
  assert.equal(destr[0].receiver, "destructured");

  // 6. type-index cancelJob
  const cancelJob = byMethod("cancelJob");
  assert.equal(cancelJob.length, 1);
  assert.equal(cancelJob[0].usage, "type-index");
  assert.equal(cancelJob[0].replacement, "jobs.cancel");

  // 7. value-reference getSession
  const valueRef = byMethod("getSession").filter((r) => r.usage === "value-reference");
  assert.equal(valueRef.length, 1);
  assert.equal(valueRef[0].receiver, "direct");

  // 8 & 9. Pick capabilities (both narrowed and callback param)
  const capCalls = byMethod("capabilities");
  assert.equal(capCalls.length, 2);

  const parameterDestructure = byMethod("getSession").filter(
    (r) => r.usage === "destructure" && r.receiver === "parameter-destructured",
  );
  assert.equal(parameterDestructure.length, 1);

  const explicitMapped = byMethod("getSession").filter((r) => r.usage === "type-index");
  assert.equal(explicitMapped.length, 1);

  // Existing 9 plus parameter destructure, explicit mapped type index and its call.
  assert.equal(result.references.length, 12);
});

test("discovers every app and package workspace that imports the client", () => {
  const cwd = mkdtempSync(join(tmpdir(), "client-scan-workspaces-"));
  try {
    for (const workspace of ["apps/cli", "apps/new-app", "packages/client", "packages/new-package"]) {
      mkdirSync(join(cwd, workspace, "src"), { recursive: true });
      writeFileSync(join(cwd, workspace, "tsconfig.json"), "{}");
      writeFileSync(
        join(cwd, workspace, "src/index.ts"),
        workspace === "packages/new-package" ? "export const unrelated = true;" : 'import "@openharness/client";',
      );
    }
    const configs = discoverWorkspaceScanConfigs(cwd).map((item) => item.config);
    assert.deepEqual(configs, [
      "apps/cli/tsconfig.json",
      "apps/new-app/tsconfig.json",
      "packages/client/tsconfig.json",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dynamically recognizes newly added compatibility methods from contract map", () => {
  const source = `
import { OpenHarnessClient } from "@openharness/client";
declare const client: OpenHarnessClient;
client.newCompatMethod();
`;

  const clientDts = `
export declare class OpenHarnessClient {
  newCompatMethod(): void;
}
`;

  const hostMap = new Map([
    ["/workspace/src/demo.ts", source],
    ["/workspace/node_modules/@openharness/client/index.d.ts", clientDts],
    ["/lib.d.ts", ""],
  ]);

  const compilerHost = {
    getSourceFile: (f) =>
      hostMap.has(f)
        ? ts.createSourceFile(f, hostMap.get(f), ts.ScriptTarget.Latest, true)
        : undefined,
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/workspace",
    getDirectories: () => [],
    fileExists: (f) => hostMap.has(f),
    readFile: (f) => hostMap.get(f),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };

  const program = ts.createProgram(
    ["/workspace/src/demo.ts"],
    { moduleResolution: ts.ModuleResolutionKind.Node10, target: ts.ScriptTarget.ES2022 },
    compilerHost,
  );

  const compatMethods = new Map([["newCompatMethod", "custom.newMethod"]]);

  const result = scanClientLegacyCalls({
    cwd: "/workspace",
    compatMethods,
    programs: [{ program, scanFiles: ["/workspace/src/demo.ts"] }],
  });

  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].method, "newCompatMethod");
  assert.equal(result.references[0].replacement, "custom.newMethod");
});

test("loads permanent legacy names from ledger after contract compatibility entries disappear", () => {
  const cwd = mkdtempSync(join(tmpdir(), "client-legacy-ledger-"));
  try {
    const ledgerPath = join(cwd, "ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({
      baseline: {
        methods: [
          { name: "health", replacement: "protocol.health" },
          { name: "getSession", replacement: "sessions.get" },
        ],
      },
    }));

    assert.deepEqual([...loadLegacyMethods(ledgerPath)], [
      ["health", "protocol.health"],
      ["getSession", "sessions.get"],
    ]);

    const hostMap = new Map([
      ["/workspace/src/demo.ts", 'import { OpenHarnessClient } from "@openharness/client"; declare const client: OpenHarnessClient; client.health();'],
      ["/workspace/node_modules/@openharness/client/index.d.ts", "export declare class OpenHarnessClient { health(): Promise<void>; }"],
      ["/lib.d.ts", "interface Promise<T> {}"],
    ]);
    const compilerHost = {
      getSourceFile: (fileName) => hostMap.has(fileName)
        ? ts.createSourceFile(fileName, hostMap.get(fileName), ts.ScriptTarget.Latest, true)
        : undefined,
      getDefaultLibFileName: () => "/lib.d.ts",
      writeFile: () => {},
      getCurrentDirectory: () => "/workspace",
      getDirectories: () => [],
      fileExists: (fileName) => hostMap.has(fileName),
      readFile: (fileName) => hostMap.get(fileName),
      getCanonicalFileName: (fileName) => fileName,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
    };
    const program = ts.createProgram(
      ["/workspace/src/demo.ts"],
      { moduleResolution: ts.ModuleResolutionKind.Node10, target: ts.ScriptTarget.ES2022 },
      compilerHost,
    );
    const result = scanClientLegacyCalls({
      cwd: "/workspace",
      ledgerPath,
      programs: [{ program, scanFiles: ["/workspace/src/demo.ts"] }],
    });
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].method, "health");
    assert.equal(result.references[0].replacement, "protocol.health");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
