import { mkdtemp, mkdir, rm, readFile, writeFile, rename, access } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireDataRootWriter, listDataRootWriters, readDataRootSelector } from "@vykor/host-config/paths";
import { SessionDatabase } from "../../../../services/src/database/session-database.js";
import { DaemonSystemService } from "../system-service.js";
import * as coordination from "../index.js";
import { readDaemonRegistry } from "../../daemon/paths.js";
const owned: string[] = [];
afterEach(async () => { for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "migration-runtime-")); owned.push(root);
  const homeDir = join(root, "home"), sourceRoot = join(root, "source"), targetRoot = join(root, "target");
  await mkdir(homeDir); SessionDatabase.open({ path: join(sourceRoot, "data/session-runtime/sessions.db") }).close();
  const request = { homeDir, sourceRoot, targetRoot, environment: {}, legacy: { documentsDir: join(root, "Documents"), userDataDir: join(root, "Desktop") } };
  const systemService = new DaemonSystemService({ platform: "linux", homeDir, logsDir: join(sourceRoot, "data/logs"), invocation: { command: process.execPath, args: [], cwd: root }, runCommand: () => { throw new Error("must never touch real services"); } });
  return { request, systemService };
}
it.each(["cli", "desktop", "sdk-control"] as const)("refuses a live %s writer before changing the selector", async kind => {
  const { request, systemService } = await fixture();
  const writer = await acquireDataRootWriter({ homeDir: request.homeDir, dataRoot: request.sourceRoot, kind });
  try {
    await expect((coordination as any).migrateDataRootAndRestart(request, { systemService,
      validation: { command: "must-not-start", args: [] }, target: { command: "must-not-start", args: [], cwd: request.homeDir } })).rejects.toMatchObject({ code: "data_root_writers_busy", writers: [{ kind, pid: process.pid }] });
    expect(readDataRootSelector(request.homeDir)).toBeUndefined();
  } finally { await writer.release(); }
}, 20000);

it("stops the old owned daemon and publishes a fresh target daemon only after durable release", async () => {
  const { request, systemService } = await fixture();
  const cli = fileURLToPath(new URL("../../../../../apps/cli/src/index.ts", import.meta.url)), loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const invocation = (root: string) => ({ command: process.execPath, args: ["--import", loader, cli, "--data-root", root, "serve", "--register"], cwd: request.homeDir });
  const launch = invocation(request.sourceRoot);
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: { ...process.env, HOME: request.homeDir, USERPROFILE: request.homeDir, VYKOR_CONFIG_DIR: undefined, VYKOR_DATA_DIR: undefined, VYKOR_CHANNELS_DIR: undefined, VYKOR_IMAGE_ATTACHMENT_CACHE_DIR: undefined }, stdio: "ignore", windowsHide: true });
  const wait = async (root: string) => {
    for (let i = 0; i < 450; i++) { const registry = readDaemonRegistry(join(root, "data/daemon/registry.json")); if (registry) return registry; await sleep(100); }
    throw new Error("owned daemon did not publish");
  };
  let replacement: number | undefined;
  try {
    const old = await wait(request.sourceRoot);
    const migrated = await coordination.migrateDataRootAndRestart(request, { systemService,
      validation: { command: process.execPath, args: ["--import", loader, cli, "--internal-data-root-validation"] }, target: invocation(request.targetRoot) });
    const next = await wait(request.targetRoot); replacement = next.pid;
    expect(migrated).toMatchObject({ phase: "committed", writersReleased: true, startup: "ready" });
    expect(next.pid).not.toBe(old.pid); expect(next.token).not.toBe(old.token);
    expect(next.storePath).toBe(join(request.targetRoot, "data/session-runtime/sessions.db"));
    expect(readDataRootSelector(request.homeDir)).toEqual({ version: 1, dataRoot: request.targetRoot });
  } finally {
    child.kill("SIGTERM");
    if (replacement) { try { process.kill(replacement, "SIGTERM"); } catch {} }
    for (let i = 0; i < 100; i++) { const alive = [child.pid, replacement].filter((pid): pid is number => !!pid).some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); if (!alive) break; await sleep(100); }
  }
}, 120000);

it("retains direct daemon ownership through exit writes after runtime close", async () => {
  const { request } = await fixture(), marker = join(request.homeDir, "exiting");
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const script = `import { initializeDataRoot } from '@vykor/host-config/paths'; import {writeFileSync} from 'node:fs';
    await initializeDataRoot(${JSON.stringify({homeDir:request.homeDir,explicitRoot:request.sourceRoot,env:{}})});
    const {runRegisteredDaemon}=await import(${JSON.stringify(new URL("../registered-daemon.ts",import.meta.url).href)});const stop=new AbortController();
    await runRegisteredDaemon({launcher:'cli',version:'test',signal:stop.signal,start:async()=>({listen:{url:'http://127.0.0.1:10000'},server:{store:{path:${JSON.stringify(join(request.sourceRoot,"data/session-runtime/sessions.db"))}},application:{activateBackgroundWork(){setTimeout(()=>stop.abort(),0)}},close:async()=>{}}})});
    process.on('exit',()=>{writeFileSync(${JSON.stringify(marker)},'wait');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);writeFileSync(${JSON.stringify(join(request.sourceRoot,"final-write"))},'finished');});`;
  const child=spawn(process.execPath,["--import",loader,"--input-type=module","-e",script],{env:{...process.env,HOME:request.homeDir,USERPROFILE:request.homeDir,VYKOR_CONFIG_DIR:undefined,VYKOR_DATA_DIR:undefined,VYKOR_CHANNELS_DIR:undefined,VYKOR_IMAGE_ATTACHMENT_CACHE_DIR:undefined},stdio:["ignore","ignore","pipe"],windowsHide:true});
  let stderr="";child.stderr?.on("data",chunk=>{stderr+=String(chunk);});
  const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
  try {
    for(let n=0;n<600;n++){if(await readFile(marker,"utf8").then(()=>true,()=>false))break;await sleep(20);}
    expect(await readFile(marker,"utf8").catch(()=>stderr)).toBe("wait");
    expect(await listDataRootWriters(request.sourceRoot)).toMatchObject([{pid:child.pid,kind:"daemon"}]);
    await exited;
    expect(await readFile(join(request.sourceRoot,"final-write"),"utf8")).toBe("finished");
    expect(await listDataRootWriters(request.sourceRoot)).toEqual([]);
  } finally {child.kill("SIGTERM");await exited;}
},20000);

it("keeps the committed target when the ordinary child cannot start after release", async () => {
  const { request, systemService } = await fixture();
  const cli = fileURLToPath(new URL("../../../../../apps/cli/src/index.ts", import.meta.url)), loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const migrated = await coordination.migrateDataRootAndRestart(request, { systemService,
    validation: { command: process.execPath, args: ["--import", loader, cli, "--internal-data-root-validation"] },
    target: { command: join(request.homeDir, "missing-owned-executable"), args: ["--data-root", request.targetRoot], cwd: request.homeDir }, timeoutMs: 1000 });
  expect(migrated, await readFile(migrated.journalPath, "utf8")).toMatchObject({ phase: "committed", writersReleased: true, startup: "failed" });
  expect(readDataRootSelector(request.homeDir)).toEqual({ version: 1, dataRoot: request.targetRoot });
  await writeFile(join(request.targetRoot, "legitimate-post-release"), "preserve newer target data");
  expect(await coordination.recoverDataRootMigration(migrated.journalPath, { homeDir: request.homeDir })).toMatchObject({ phase: "committed", writersReleased: true });
  expect(readDataRootSelector(request.homeDir)).toEqual({ version: 1, dataRoot: request.targetRoot });
  expect(await readFile(join(request.targetRoot, "legitimate-post-release"), "utf8")).toBe("preserve newer target data");
}, 60000);

it("reports daemon busy without pausing or reinstalling its still-running service", async () => {
  const { request, systemService } = await fixture();
  vi.spyOn(systemService, "snapshotForMigration").mockReturnValue({ version: 1, installed: true, wasRunning: true, wasEnabled: true, definition: "original", options: { platform: "linux", homeDir: request.homeDir, logsDir: join(request.sourceRoot, "data/logs"), invocation: systemService.invocation() } });
  const pause = vi.spyOn(systemService, "pauseForMigration"), restore = vi.spyOn(systemService, "restoreMigrationSnapshot"), resume = vi.spyOn(systemService, "resumeMigrationSnapshot");
  const file = join(request.sourceRoot, "data/daemon/registry.json");
  const script = `const fs=require('node:fs'), http=require('node:http'); const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json'); if(req.url==='/debug/process') res.end(JSON.stringify({pid:process.pid})); else {res.statusCode=409;res.end(JSON.stringify({error:'PRIVATE_BUSY_BODY'}));}}); server.listen(0,'127.0.0.1',()=>{fs.mkdirSync(require('node:path').dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+server.address().port,token:'owned-token',version:'test',storePath:process.argv[2],startedAt:Date.now()}));});`;
  const child = spawn(process.execPath, ["-e", script, file, join(request.sourceRoot, "data/session-runtime/sessions.db")], { stdio: "ignore", windowsHide: true });
  try {
    for (let n=0; n<100 && !readDaemonRegistry(file); n++) await sleep(20);
    const migrated = await coordination.migrateDataRootAndRestart(request, { systemService, validation: { command: "must-not-start", args: [] }, target: { command: "must-not-start", args: ["--data-root", request.targetRoot], cwd: request.homeDir } });
    expect(migrated).toMatchObject({ phase: "failed", recoveryWritersReleased: true, blockers: [{ code: "daemon_busy", pid: child.pid }] });
    expect(pause).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
    expect(process.kill(child.pid!, 0)).toBe(true); expect(readDataRootSelector(request.homeDir)).toBeUndefined();
    expect(await readFile(migrated.journalPath, "utf8")).not.toContain("PRIVATE_BUSY_BODY");
  } finally {
    child.kill("SIGTERM"); for (let n=0;n<100;n++){try{process.kill(child.pid!,0);}catch{break;}await sleep(20);}
    vi.restoreAllMocks();
  }
}, 30000);

it("sanitizes malformed source registry before any migration writes", async () => {
  const { request, systemService } = await fixture();
  await mkdir(join(request.sourceRoot, "data/daemon"), { recursive: true });
  await writeFile(join(request.sourceRoot, "data/daemon/registry.json"), '{"secret":"PRIVATE_PARSE_SENTINEL", nope}');
  const failed = coordination.migrateDataRootAndRestart(request, { systemService, validation: { command: "unused", args: [] }, target: { command: "unused", args: ["--data-root", request.targetRoot], cwd: request.homeDir } });
  await expect(failed).rejects.toThrow("Cannot verify migration daemon registration");
  expect(readDataRootSelector(request.homeDir)).toBeUndefined();
});

async function ownedRegistered(file: string, storePath: string) {
  const script = `const fs=require('node:fs'),http=require('node:http'),path=require('node:path'); const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/debug/process'?{pid:process.pid}:{prepared:true}));});server.listen(0,'127.0.0.1',()=>{fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,url:'http://127.0.0.1:'+server.address().port,token:'owned-old-token',version:'old',storePath:process.argv[2],startedAt:Date.now()}));});process.on('SIGTERM',()=>server.close(()=>{fs.unlinkSync(process.argv[1]);process.exit(0);}));`;
  const child = spawn(process.execPath, ["-e", script, file, storePath], { stdio: "ignore", windowsHide: true });
  for (let n=0; n<100 && !readDaemonRegistry(file); n++) await sleep(20);
  return child;
}
async function closeOwned(child: ChildProcess) {
  child.kill("SIGTERM"); for(let n=0;n<100;n++){try{process.kill(child.pid!,0);}catch{return;}await sleep(20);}
}
it("moves a known legacy runtime registry and actual Windows launcher without creating a second source database", async () => {
  const { request } = await fixture();
  const legacy = join(request.homeDir, "old-runtime"), oldDb = join(legacy, "custom.db"), canonical = join(request.sourceRoot, "data/session-runtime/sessions.db");
  await mkdir(join(legacy, "daemon"), { recursive: true }); await mkdir(join(legacy, "logs"));
  await rename(canonical, oldDb); await mkdir(join(request.sourceRoot, "data/daemon"), { recursive: true });
  await writeFile(join(request.sourceRoot, "data/daemon/data-location.json"), JSON.stringify({ version: 1, location: { directory: legacy, storePath: oldDb } }));
  await writeFile(join(legacy, "daemon/daemon-watchdog.vbs"), "original-private-launcher");
  let running = true, enabled = true; const registrations: string[] = [];
  const systemService = new DaemonSystemService({ platform: "win32", homeDir: request.homeDir, logsDir: join(legacy, "logs"), invocation: { command: process.execPath, args: ["/desktop-main", "--data-root", request.sourceRoot, "--daemon-watchdog"], cwd: request.homeDir }, runCommand: (_command, args, env) => {
    const call = args.join(" ");
    if(call.includes("ConvertTo-Json")) return {status:0,stdout:JSON.stringify({running,enabled}),stderr:""};
    if(call.includes("Export-ScheduledTask")) return {status:0,stdout:"<Task>original-private-definition</Task>",stderr:""};
    if(call.includes("Get-ScheduledTask")) return {status:0,stdout:running?"running":enabled?"ready":"disabled",stderr:""};
    if(call.includes("Stop-ScheduledTask")) running=false;
    if(call.includes("Disable-ScheduledTask")) enabled=false;
    if(call.includes("Enable-ScheduledTask")) enabled=true;
    if(call.includes("Start-ScheduledTask")) running=true;
    if(env?.VK_TASK_ARGUMENTS) registrations.push(env.VK_TASK_ARGUMENTS);
    return {status:0,stdout:"",stderr:""};
  } });
  const old = await ownedRegistered(join(legacy, "daemon/registry.json"), oldDb);
  try {
    const cli = fileURLToPath(new URL("../../../../../apps/cli/src/index.ts", import.meta.url)), loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const migrated = await coordination.migrateDataRootAndRestart(request, { systemService, validation: { command: process.execPath, args: ["--import",loader,cli,"--internal-data-root-validation"] }, target: { command: join(request.homeDir,"missing-target"), args: ["--data-root",request.targetRoot], cwd:request.homeDir },timeoutMs:500 });
    expect(migrated).toMatchObject({phase:"committed",writersReleased:true,startup:"failed"});
    expect(() => process.kill(old.pid!, 0)).toThrow();
    await expect(access(canonical)).rejects.toThrow();
    const launcher=await readFile(join(request.targetRoot,"data/daemon/daemon-watchdog.vbs"),"utf8"); expect(launcher).toContain(request.targetRoot); expect(launcher).not.toContain(request.sourceRoot);
    expect(registrations.some(value=>value.includes(request.targetRoot))).toBe(true);
    expect(JSON.parse(await readFile(migrated.journalPath,"utf8")).preparation.runtimeDirectories.some((entry:{path:string})=>entry.path===legacy)).toBe(true);
  } finally { await closeOwned(old); }
},60000);
it("refuses multiple live canonical and known legacy source daemons before any side effects", async () => {
  const { request, systemService } = await fixture(), legacy = join(request.homeDir,"old-runtime"), oldDb=join(legacy,"custom.db");
  await mkdir(legacy); await rename(join(request.sourceRoot,"data/session-runtime/sessions.db"),oldDb); await mkdir(join(request.sourceRoot,"data/daemon"),{recursive:true});
  await writeFile(join(request.sourceRoot,"data/daemon/data-location.json"),JSON.stringify({version:1,location:{directory:legacy,storePath:oldDb}}));
  const first=await ownedRegistered(join(legacy,"daemon/registry.json"),oldDb), second=await ownedRegistered(join(request.sourceRoot,"data/daemon/registry.json"),oldDb);
  try {
    await expect(coordination.migrateDataRootAndRestart(request,{systemService,validation:{command:"unused",args:[]},target:{command:"unused",args:["--data-root",request.targetRoot],cwd:request.homeDir}})).rejects.toMatchObject({code:"data_root_writers_busy",writers:expect.arrayContaining([{kind:"daemon",pid:first.pid,path:join(legacy,"daemon/registry.json")},{kind:"daemon",pid:second.pid,path:join(request.sourceRoot,"data/daemon/registry.json")}])});
    expect(readDataRootSelector(request.homeDir)).toBeUndefined();
  } finally {await closeOwned(first);await closeOwned(second);}
});
