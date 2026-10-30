import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@vykor/host-config";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import { createSessionEnvironmentAcquirer } from "../../../runtime/session-execution-environment.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";
import { SessionFileService } from "../session-file-service.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.each([
  {operation:"readText",scope:"outside"}, {operation:"search",scope:"outside"},
  {operation:"readText",scope:"denied"}, {operation:"search",scope:"denied"},
] as const)("$operation rejects a directory replaced with $scope content after path authorization", async ({operation,scope}) => {
  const root = await mkdtemp(join(tmpdir(), "vk-opened-file-")); roots.push(root);
  const workspace = join(root, "workspace"), inside = join(workspace, "inside"), outside = scope === "outside" ? join(root,"outside") : join(workspace,"private");
  await mkdir(inside, { recursive: true }); await mkdir(outside);
  await writeFile(join(inside, "value.txt"), "allowed text");
  await writeFile(join(outside, "value.txt"), "outside fixture text");
  const session: SessionRecord = { id: "session", cwd: workspace, title: "", model: "test", metadata: { runtime: { model: "test" } }, status: "idle", createdAt: 1, updatedAt: 1 };
  const settings = { model: "test", apiFormat: "openai", maxTurns: 1, permission: { mode: "default",pathRules:[{pattern:"**/private/**",allow:false}] }, agentEnvironment: { kind: "native" }, sandbox: { enabled: false } } as Settings;
  const gate = new DaemonOperationGate();
  let replaced = false, released = 0, readCalls = 0;
  const cleanup:string[]=[];
  const replace = async () => {
    if (replaced) return;
    replaced = true;
    await rename(inside, join(workspace, "original"));
    await symlink(outside, inside, process.platform === "win32" ? "junction" : "dir");
  };
  const service = new SessionFileService({
    getSession: () => session, getSettings: () => settings,
    readiness: () => ({ phase: "ready", accepting: true }), enter: scope => gate.enter(scope),
    acquireEnvironment: async (record, config) => {
      const environment = await createSessionEnvironmentAcquirer()(record, config);
      // Schedule a real filesystem change at the actual I/O boundary, after service authorization.
      const read = environment.files.readBytes.bind(environment.files);
      environment.files.readBytes = async (path, options) => { await replace(); return read(path, options); };
      const openRead = environment.files.openRead?.bind(environment.files);
      if (openRead) environment.files.openRead = async (path, signal) => {
        await replace(); const reader=await openRead(path, signal);
        return {...reader,readBytes:async options=>{readCalls++;return reader.readBytes(options);},close:async()=>{await reader.close();cleanup.push("close");}};
      };
      return { ...environment, release: async () => { released++; await environment.release();cleanup.push("release"); } };
    },
  });
  const request = operation === "readText" ? service.readText("session", "inside/value.txt") : service.search("session", { query: "fixture" });
  await expect(request).rejects.toMatchObject({ code: "file_forbidden" });
  expect(replaced).toBe(true);
  expect(released).toBe(1);
  expect(readCalls).toBe(0);
  expect(cleanup).toEqual(["close","release"]);
  const barrier = gate.tryEnterBarrier({ kind: "global" }, () => true);
  expect(barrier).toBeDefined(); barrier!.release();
});

it.each(["readText","search"] as const)("%s refuses an environment without safe open instead of using pathname reads", async operation => {
  const root=await mkdtemp(join(tmpdir(),"vk-no-open-reader-"));roots.push(root);
  await writeFile(join(root,"value.txt"),"fixture");
  const session:SessionRecord={id:"session",cwd:root,title:"",model:"test",metadata:{runtime:{model:"test"}},status:"idle",createdAt:1,updatedAt:1};
  const settings={model:"test",apiFormat:"openai",maxTurns:1,permission:{mode:"default"},agentEnvironment:{kind:"native"},sandbox:{enabled:false}} as Settings;
  let fallbackReads=0,released=0;
  const service=new SessionFileService({getSession:()=>session,getSettings:()=>settings,
    readiness:()=>({phase:"ready",accepting:true}),enter:()=>({release(){}}),
    acquireEnvironment:async(record,config)=>{
      const environment=await createSessionEnvironmentAcquirer()(record,config);
      environment.files.openRead=undefined;
      environment.files.readBytes=async()=>{fallbackReads++;return Buffer.from("fixture");};
      return {...environment,release:async()=>{released++;await environment.release();}};
    },
  });
  const pending=operation==="readText"?service.readText("session","value.txt"):service.search("session",{query:"fixture"});
  await expect(pending).rejects.toMatchObject({code:"file_not_supported"});
  expect(fallbackReads).toBe(0);expect(released).toBe(1);
});
