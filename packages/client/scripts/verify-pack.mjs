import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "vykor-client-pack-"));
if (dirname(sandbox) !== resolve(tmpdir())) throw new Error("Unexpected package verification directory");
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("Run this script through pnpm");
const npmCli = [
  join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(file => existsSync(file));
if (!npmCli) throw new Error("Cannot locate npm beside Node.js; install a Node distribution that includes npm");
const tsc = join(packageRoot, "node_modules/typescript/bin/tsc");

try {
  execFileSync(process.execPath, [pnpmCli, "pack", "--pack-destination", sandbox], { cwd: packageRoot, stdio: "pipe" });
  const tarball = join(sandbox, readdirSync(sandbox).find(name => name.endsWith(".tgz")));
  writeFileSync(join(sandbox, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball], { cwd: sandbox, stdio: "pipe" });
  const installed = join(sandbox, "node_modules/@rzx/client");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, "SDK must not require unpublished workspace packages");
  assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./service"], "Private application entries must not be published");
  for (const name of ["index.js", "index.d.ts", "service.js", "service.d.ts"]) {
    const content = readFileSync(join(installed, "dist", name), "utf8");
    assert.doesNotMatch(content, /(?:from\s*|import\s*\()\s*["'](?:@vykor\/|@rzx\/client(?:\/|["']))/, `${name} leaks workspace imports`);
  }

  const fixture = fileURLToPath(new URL("../src/service/__test__/service-fixture.mjs", import.meta.url));
  writeFileSync(join(sandbox, "consumer.mjs"), `
import assert from "node:assert/strict";
import * as sdk from "@rzx/client";
import { VykorClient, createInitialClientState, CURRENT_PROTOCOL_VERSION } from "@rzx/client";
import { Service } from "@rzx/client/service";
const endpoint = await Service.ensure({
  file: ${JSON.stringify(join(sandbox, "registry.json"))},
  command: [process.execPath, ${JSON.stringify(fixture)}, ${JSON.stringify(join(sandbox, "registry.json"))}, "1.2.3", String(CURRENT_PROTOCOL_VERSION)],
  timeoutMs: 5000,
});
try {
  const client = new VykorClient(Service.clientOptions(endpoint));
  for (const key of ["notes", "channels", "schedules", "plugins", "pluginApps", "system", "providers", "terminals"]) assert.equal(key in client, false, key);
  for (const key of ["NoteResource", "dispatchSessionCommand", "mergeNotes", "officeFormat"]) assert.equal(key in sdk, false, key);
  assert.equal("scanStorage" in client.attachments, false);
  assert.ok(client.files instanceof sdk.FilesResource);
  for (const key of ["list", "stat", "readText", "find", "search"]) assert.equal(typeof client.files[key], "function", key);
  for (const key of ["write", "writeText", "delete", "create", "mkdir", "remove"]) assert.equal(key in client.files, false, key);
  assert.equal(typeof sdk.waitForRun, "function");
  assert.deepEqual(await client.sessions.list(), []);
  assert.equal(createInitialClientState().lastSeq, 0);
  assert.equal((await Service.discover({ file: endpoint.file })).pid, endpoint.pid);
} finally { await Service.stop(endpoint); }
console.log("packed Node client and service: ok");
`);
  execFileSync(process.execPath, [join(sandbox, "consumer.mjs")], { cwd: sandbox, stdio: "inherit", timeout: 20_000 });

  writeFileSync(join(sandbox, "consumer.ts"), `
import { VykorClient, FilesResource, syncEvents, waitForRun, type SessionRecord, type SessionRunRecord,
  type SessionDirectoryResult, type SessionFileInfo, type SessionTextFileResult,
  type SessionFindFilesResult, type SessionSearchFilesResult, type SessionFileErrorCode,
} from "@rzx/client";
// @ts-expect-error product types must not exist in the installed SDK
import type { NoteRecord } from "@rzx/client";
// @ts-expect-error UI contracts must not exist in the installed SDK
import type { PluginAppConversationRequest } from "@rzx/client";
import { Service, type ServiceEndpoint } from "@rzx/client/service";
const client = new VykorClient({ baseUrl: "http://127.0.0.1:8787" });
async function consume(endpoint: ServiceEndpoint) {
  const connected = new VykorClient(Service.clientOptions(endpoint));
  const session: SessionRecord = await connected.sessions.create({ cwd: "/workspace", model: "configured-model" });
  const files: FilesResource = connected.files;
  const signal = AbortSignal.timeout(1000);
  const directory: SessionDirectoryResult = await files.list(session.id, { path: ".", limit: 20, signal });
  const file: SessionFileInfo = await files.stat(session.id, "README.md", { signal });
  const text: SessionTextFileResult = await files.readText(session.id, "README.md", { maxBytes: 4096, signal });
  const found: SessionFindFilesResult = await files.find(session.id, { pattern: "**/*.ts", path: "src", limit: 10, signal });
  const searched: SessionSearchFilesResult = await files.search(session.id, { query: "literal [text]", include: "**/*.ts", caseSensitive: false, limit: 10, signal });
  const filePaths: string[] = found.files;
  const fileError: SessionFileErrorCode = "file_not_text";
  void [directory.entries, file.sizeBytes, file.modifiedAt, text.encoding, filePaths, searched.matches, fileError];
  // @ts-expect-error session workspace files have no write API
  files.write(session.id, "README.md", "changed");
  // @ts-expect-error session workspace files have no delete API
  files.delete(session.id, "README.md");
  // @ts-expect-error session workspace files have no create API
  files.create(session.id, "new.txt");
  // @ts-expect-error the session chooses the workspace root
  files.list(session.id, { cwd: "/arbitrary-host-directory" });
  await connected.sessions.admitPrompt(session.id, { items: [{ type: "text", text: "hello" }] });
  await waitForRun(connected, { sessionId: session.id, runId: "run", signal: AbortSignal.timeout(1000) });
  for await (const update of syncEvents(client, { sessionId: session.id })) {
    const runs: Record<string, SessionRunRecord> = update.state.buckets[session.id]!.runs;
    void runs;
  }
  const snapshot = await client.sessions.getState(session.id);
  // @ts-expect-error application snapshot extensions are private
  snapshot.pluginApps;
  // @ts-expect-error cwd must be a string.
  await client.sessions.create({ cwd: 42, model: "configured-model" });
  // @ts-expect-error application resources are private
  client.notes;
  // @ts-expect-error storage maintenance is private
  client.attachments.scanStorage();
  // @ts-expect-error plugin application inputs are private
  client.sessions.admitPrompt(session.id, { items: [], pluginAppContexts: [] });
}
void consume;
`);
  for (const resolution of ["NodeNext", "Bundler"]) {
    writeFileSync(join(sandbox, "tsconfig.json"), JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, types: [], lib: ["ES2022", "DOM", "DOM.Iterable"], target: "ES2022", moduleResolution: resolution, module: resolution === "NodeNext" ? "NodeNext" : "ESNext" },
      files: ["consumer.ts"],
    }));
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: sandbox, stdio: "inherit" });
  }
  console.log("packed public declarations (NodeNext and Bundler): ok");
  const browser = await build({
    stdin: { contents: `
import { VykorClient } from "@rzx/client";
const client = new VykorClient({baseUrl:"http://localhost:8787"});
window.client = client;
window.readSessionWorkspace = async (sessionId, signal) => Promise.all([
  client.files.list(sessionId, { signal }),
  client.files.stat(sessionId, "README.md", { signal }),
  client.files.readText(sessionId, "README.md", { signal }),
  client.files.find(sessionId, { pattern: "**/*.ts", signal }),
  client.files.search(sessionId, { query: "text", signal }),
]);`, resolveDir: sandbox },
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true,
  });
  assert.ok(Object.keys(browser.metafile.inputs).every(name => !name.includes("service.js")), "Browser consumer imported local process management");
  console.log("packed browser consumer: ok");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
