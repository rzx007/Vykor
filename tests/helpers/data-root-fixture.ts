import { mkdtemp, mkdir, rm, writeFile, appendFile, lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VykorClient } from "@rzx/client";
import { migrateDataRoot } from "../../packages/server/src/daemon-host/data-root-migration.js";
const fixturePreloads = new Map<string, string>();
const execute = promisify(execFile);
const loader = pathToFileURL(createRequire(new URL("../../apps/cli/package.json", import.meta.url)).resolve("tsx")).href;

/** Only metadata and hashes from caller-owned fixture databases, never rows. */
export async function rootDatabaseMetadata(root: string) {
  const path = join(root, "data/session-runtime/sessions.db");
  return Promise.all([path, `${path}-wal`, `${path}-shm`].map(async path => {
    try { const metadata = await lstat(path), bytes = await readFile(path); return { path, dev: metadata.dev, ino: metadata.ino, size: metadata.size,
      mtimeMs: metadata.mtimeMs, sha256: createHash("sha256").update(bytes).digest("hex") }; }
    catch (error) { return { path, code: (error as NodeJS.ErrnoException).code }; }
  }));
}

export async function rootFixture() {
  const directory = await mkdtemp(join(tmpdir(), "vykor-root-acceptance-"));
  const homeDir = join(directory, "home"), sourceRoot = join(directory, "旧根"), targetRoot = join(directory, "新根");
  const documentsDir = join(directory, "Documents"), userDataDir = join(directory, "Desktop");
  await mkdir(homeDir);
  await mkdir(join(sourceRoot, "workspaces", "chat"), { recursive: true });
  const request = (from = sourceRoot, to = targetRoot) => ({ homeDir, sourceRoot: from, targetRoot: to,
    environment: {}, rootInputs: { homeDir, environment: {} }, legacy: { documentsDir, userDataDir } });
  const file = async (path: string, content: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir,
    APPDATA: join(homeDir, "AppData/Roaming"), LOCALAPPDATA: join(homeDir, "AppData/Local"), CODEX_HOME: join(homeDir, ".codex"), VYKOR_DISABLE_MODELS_FETCH: "1" };
  for (const key of ["VYKOR_CONFIG_DIR", "VYKOR_DATA_DIR", "VYKOR_CHANNELS_DIR", "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR"]) delete environment[key];
  const diagnostics = join(directory, "lifecycle.jsonl"), preload = join(directory, "owned-cli-preload.cjs");
  await file(preload, `const fs=require('node:fs');const log=value=>fs.appendFileSync(${JSON.stringify(diagnostics)},JSON.stringify({time:Date.now(),pid:process.pid,...value})+'\\n');
const allowed=host=>!host||['localhost','127.0.0.1','::1','[::1]'].includes(host);
const check=value=>{const host=typeof value==='string'||value instanceof URL?new URL(value).hostname:value?.hostname||value?.host;if(!allowed(host)){log({event:'external-network-blocked',host});throw Object.assign(new Error('Owned fixture blocks external network'),{code:'OWNED_FIXTURE_EXTERNAL_NETWORK_BLOCKED'})}};
const fetch=globalThis.fetch;globalThis.fetch=(input,...rest)=>{check(typeof input==='object'&&input.url?input.url:input);return fetch(input,...rest)};
for(const name of ['node:http','node:https']){const mod=require(name);for(const method of ['request','get']){const original=mod[method];mod[method]=function(input,...rest){check(input);return original.call(this,input,...rest)}}}
for(const name of ['node:net','node:tls']){const mod=require(name);for(const method of ['connect','createConnection']){const original=mod[method];if(!original)continue;mod[method]=function(input,...rest){check({host:typeof input==='number'?(typeof rest[0]==='string'?rest[0]:undefined):input?.host||input?.servername});return original.call(this,input,...rest)}}}
const stderrPath=${JSON.stringify(join(directory, "owned-cli-stderr.log"))},write=process.stderr.write.bind(process.stderr);process.stderr.write=function(chunk,...args){const size=fs.existsSync(stderrPath)?fs.statSync(stderrPath).size:0;if(size<65536){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));fs.appendFileSync(stderrPath,bytes.subarray(0,65536-size))}return write(chunk,...args)};
log({event:'child-start'});process.on('exit',code=>log({event:'child-exit',code}));
`);
  fixturePreloads.set(homeDir, preload);
  const diagnose = async (event: string, details: Record<string, unknown> = {}) => appendFile(diagnostics, JSON.stringify({ time: Date.now(), pid: process.pid, event, ...details,
    source: await rootDatabaseMetadata(sourceRoot), target: await rootDatabaseMetadata(targetRoot) }) + "\n");
  const continueFormal = async (root: string, sessionId: string) => {
    const script = join(directory, "continue-formal.mjs");
    const selectionModule = pathToFileURL(fileURLToPath(new URL("../../packages/host-config/src/storage/data-root-selection.ts", import.meta.url))).href;
    const writerModule = pathToFileURL(fileURLToPath(new URL("../../packages/host-config/src/storage/data-root-writers.ts", import.meta.url))).href;
    await file(script, `const {initializeDataRoot,parseDataRootArgument}=await import(${JSON.stringify(selectionModule)});const {acquireDataRootWriter}=await import(${JSON.stringify(writerModule)});
const parsed=parseDataRootArgument(process.argv.slice(2));if(parsed.argv[0]!=='--session-id'||parsed.argv.length!==2)throw new Error('Invalid owned child arguments');
const selected=await initializeDataRoot({explicitRoot:parsed.explicitRoot});await acquireDataRootWriter({homeDir:process.env.USERPROFILE,dataRoot:selected.dataRoot,kind:'cli'});
const {scriptedRootServer}=await import(${JSON.stringify(import.meta.url)});let runtime;try{runtime=await scriptedRootServer(selected.dataRoot);const sessionId=parsed.argv[1];const before=await runtime.client.sessions.getState(sessionId);const run=await runtime.prompt(sessionId,'continue after migration');if(run.status!=='completed')throw new Error('Owned continuation did not complete');const after=await runtime.client.sessions.getState(sessionId);await runtime.close();runtime=undefined;process.stdout.write(JSON.stringify({pid:process.pid,root:selected.dataRoot,sessionId,status:run.status,historyPreserved:before.parts.some(part=>part.text?.includes('formal history ')),continued:after.parts.some(part=>part.text?.includes('continue after migration'))})+'\\n')}finally{await runtime?.close()}
`);
    const result = await execute(process.execPath, ["--require", preload, "--import", loader, script, "--data-root", root, "--session-id", sessionId], { env: environment, windowsHide: true, timeout: 60000 });
    return JSON.parse(result.stdout.trim()) as { pid: number; root: string; sessionId: string; status: string; historyPreserved: boolean; continued: boolean };
  };
  return { directory, homeDir, sourceRoot, targetRoot, documentsDir, userDataDir, request, file, preload, diagnostics, diagnose, continueFormal, environment,
    async close(options: { preserve?: boolean } = {}) { fixturePreloads.delete(homeDir); if (options.preserve) { console.warn(`Owned root fixture retained: ${directory}`); return; } await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
}

/** Real Agent/HTTP/SQLite wiring with an offline model stream. */
export async function scriptedRootServer(root: string) {
  const { createDefaultNodeAgent } = await import("@vykor/agent-runtime");
  const { VykorHttpServer } = await import("../../packages/server/src/http/server.js");
  const server = new VykorHttpServer({ storePath: join(root, "data/session-runtime/sessions.db"), logger: () => {},
    settings: { model: "root-fixture", apiFormat: "openai", maxTurns: 2, permission: { mode: "full_access" },
      plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false } },
    createAgent: async context => {
      const agent = await createDefaultNodeAgent({ ...context.options, client: { async *streamMessage() {
        yield { type: "text_delta", delta: "offline reply" };
        yield { type: "complete", stopReason: "end_turn" };
      } } });
      return { agent, host: agent.host };
    } });
  await server.application.ready();
  const client = new VykorClient({ baseUrl: "http://fixture.local", fetch: async (input, init) => server.app.request(String(input), init) });
  const prompt = async (id: string, text: string) => {
    const admission = await server.application.interactions.admitPrompt(id, { items: [{ type: "text", text }] });
    if (!admission.run) throw new Error("Fixture prompt was not admitted");
    return server.application.runControl.awaitRun(id, admission.run.id);
  };
  return { server, client, prompt, close: () => server.close() };
}

export function cliInvocation(args: string[], preload?: string) {
  const cli = fileURLToPath(new URL("../../apps/cli/src/index.ts", import.meta.url));
  return { command: process.execPath, args: [...(preload ? ["--require", preload] : []), "--import", loader, cli, ...args] };
}

/** Source runtime is already closed; validation still uses the real trusted CLI child. */
export async function publishRoot(request: ReturnType<Awaited<ReturnType<typeof rootFixture>>["request"]>) {
  return migrateDataRoot(request, { prepareStoppedCopy: async () => ({}), withInstalledCopy: async handle => {
    await handle.validateInNewProcess(cliInvocation(["--internal-data-root-validation"], fixturePreloads.get(request.homeDir)));
    await handle.commit();
    await handle.markWritersReleased();
  } });
}
