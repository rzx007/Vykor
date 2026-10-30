import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@vykor/host-config";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import { createSessionEnvironmentAcquirer } from "../../../runtime/session-execution-environment.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";

import { SessionFileService, type SessionFileServiceContext } from "../session-file-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, {recursive:true,force:true}))); });
const settings: Settings = { model:"test", apiFormat:"openai", maxTurns:1, permission:{mode:"default"}, agentEnvironment:{kind:"native"}, sandbox:{enabled:false} };
async function fixture(overrides: Partial<Settings> = {}) {
  const root = await mkdtemp(join(tmpdir(), "session-files-")); roots.push(root);
  const a = join(root,"a"), b = join(root,"b"); await mkdir(a); await mkdir(b);
  const session=(id:string,cwd:string):SessionRecord=>({id,cwd,title:"",model:"test",metadata:{runtime:{model:"test"}},status:"idle",createdAt:1,updatedAt:1});
  const sessions = new Map([["a",session("a",a)],["b",session("b",b)]]);
  const gate = new DaemonOperationGate();
  const released = vi.fn(); const acquired = vi.fn();
  const context: SessionFileServiceContext = {
    getSession: (id:string) => sessions.get(id),
    getSettings: async () => ({...settings,...overrides}),
    readiness: () => ({phase:"ready",accepting:true}),
    enter: scope => gate.enter(scope),
    acquireEnvironment: async (session:SessionRecord, config:Settings) => {
      acquired(session.id);
      const env = await createSessionEnvironmentAcquirer()(session, config);
      return {...env,release:async()=>{await env.release();released(session.id);}};
    },
  };
  const service = new SessionFileService(context);
  return {root,a,b,service,sessions,gate,released,acquired,context};
}
describe("session readonly files", () => {
  it("holds the workspace lease until cancelled I/O has cleaned up", async () => {
    const f=await fixture();await writeFile(join(f.a,"file.txt"),"contents");
    let entered!:()=>void, observedAbort!:()=>void, finishCleanup!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const aborted=new Promise<void>(resolve=>{observedAbort=resolve;});
    const cleaned=new Promise<void>(resolve=>{finishCleanup=resolve;});
    const acquire=f.context.acquireEnvironment;
    f.context.acquireEnvironment=async(session,config)=>{
      const environment=await acquire(session,config);
      environment.paths.canonicalize=async(_path,signal)=>{
        entered();
        await new Promise<void>(resolve=>signal!.addEventListener("abort",()=>{observedAbort();resolve();},{once:true}));
        await cleaned;
        throw signal!.reason;
      };
      return environment;
    };
    const controller=new AbortController();let settled=false;
    const pending=f.service.readText("a","file.txt",{signal:controller.signal}).then(
      ()=>{settled=true;return undefined;},error=>{settled=true;return error;},
    );
    await started;controller.abort();await aborted;
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(settled).toBe(false);expect(f.released).not.toHaveBeenCalled();
    expect(f.gate.tryEnterBarrier({kind:"global"},()=>true)).toBeUndefined();
    finishCleanup();expect(await pending).toMatchObject({code:"file_cancelled"});
    expect(f.released).toHaveBeenCalledTimes(1);
    const barrier=f.gate.tryEnterBarrier({kind:"global"},()=>true);expect(barrier).toBeDefined();barrier!.release();
  });
  it("honors persisted session tool ceilings and explicit denials", async () => {
    const f=await fixture({permission:{mode:"full_access",allowedTools:["*"],autoApproveTools:["Read"]}} as any);
    await writeFile(join(f.a,"file.txt"),"allowed contents");
    await expect(f.service.readText("a","file.txt")).resolves.toMatchObject({content:"allowed contents"});
    f.sessions.get("a")!.metadata={runtime:{model:"test",disallowedTools:["Read"]}} as any;
    await expect(f.service.readText("a","file.txt")).rejects.toMatchObject({code:"file_forbidden"});
    f.sessions.get("a")!.metadata={runtime:{model:"test",allowedTools:["Grep"]}} as any;
    await expect(f.service.readText("a","file.txt")).rejects.toMatchObject({code:"file_forbidden"});
    await expect(f.service.search("a",{query:"contents"})).resolves.toMatchObject({matches:[{path:"file.txt",line:1,text:"allowed contents"}]});
  });
  it("counts binary reads against the total content search budget", async () => {
    const f=await fixture();
    const bytes=Buffer.alloc(256*1024,0);
    await Promise.all(Array.from({length:40},(_,i)=>writeFile(join(f.a,`${i}.bin`),bytes)));
    let bytesRead=0;
    const acquire=f.context.acquireEnvironment;
    f.context.acquireEnvironment=async(session,config)=>{
      const environment=await acquire(session,config);
      const openRead=environment.files.openRead!.bind(environment.files);
      environment.files.openRead=async(path,signal)=>{
        const reader=await openRead(path,signal), read=reader.readBytes.bind(reader);
        return {...reader,readBytes:async options=>{const result=await read(options);bytesRead+=result.byteLength;return result;}};
      };
      return environment;
    };
    const result=await f.service.search("a",{query:"needle"});
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(bytesRead).toBeLessThanOrEqual(8*1024*1024);
  });
  it("preserves internal symlink information without recursing through directory aliases", async () => {
    const f=await fixture();
    await mkdir(join(f.a,"src"));await writeFile(join(f.a,"src","code.ts"),"source");
    await symlink(join(f.a,"src"),join(f.a,"alias"),process.platform==="win32"?"junction":"dir");
    expect(await f.service.stat("a","alias")).toMatchObject({path:"alias",kind:"symlink"});
    const list=await f.service.list("a");
    expect(list.entries.find((entry:any)=>entry.path==="alias")).toMatchObject({kind:"symlink"});
    expect((await f.service.find("a",{pattern:"**/*.ts"})).files).toEqual(["src/code.ts"]);
  });
  it("binds every operation to the selected session workspace without creating an Agent", async () => {
    const f = await fixture();
    await writeFile(join(f.a,"hello.txt"),"first workspace"); await writeFile(join(f.b,"hello.txt"),"second workspace");
    await mkdir(join(f.a,"src")); await writeFile(join(f.a,"src","code.ts"),"const value = 1;");
    expect((await f.service.readText("a","hello.txt")).content).toBe("first workspace");
    expect((await f.service.readText("b","hello.txt")).content).toBe("second workspace");
    const info = await f.service.stat("a","hello.txt");
    expect(info).toMatchObject({path:"hello.txt",name:"hello.txt",kind:"file",sizeBytes:15,modifiedAt:expect.any(Number)});
    const list = await f.service.list("a");
    expect(list.entries.map((entry:any)=>entry.path)).toEqual(["src","hello.txt"]);
    expect(list.truncated).toBe(false);
    expect((await f.service.find("a",{pattern:"**/*.ts"})).files).toEqual(["src/code.ts"]);
    expect(f.released).toHaveBeenCalledTimes(5);
    expect(f.acquired.mock.calls.flat()).toEqual(["a","b","a","a","a"]);
  });
  it("omits denied descendants from listing, names and content search", async () => {
    const f = await fixture({permission:{mode:"full_access",pathRules:[{pattern:"**/private/**",allow:false}]},sandbox:{enabled:false,filesystem:{denyRead:["blocked.txt"]}}} as any);
    await mkdir(join(f.a,"private")); await writeFile(join(f.a,"private","secret.txt"),"needle private");
    await writeFile(join(f.a,"blocked.txt"),"needle blocked"); await writeFile(join(f.a,"public.txt"),"first\nneedle visible\n");
    expect((await f.service.find("a",{pattern:"**/*.txt"})).files).toEqual(["public.txt"]);
    const result = await f.service.search("a",{query:"needle",include:"**/*.txt"});
    expect(result.matches).toEqual([{path:"public.txt",line:2,text:"needle visible"}]);
    expect((await f.service.list("a")).entries.map((e:any)=>e.path)).not.toContain("blocked.txt");
    await expect(f.service.readText("a","blocked.txt")).rejects.toMatchObject({code:"file_forbidden"});
  });
  it("bounds UTF-8 reads and rejects binary, missing and escaping paths", async () => {
    const f = await fixture(); await writeFile(join(f.a,"text.txt"),"你好 world"); await writeFile(join(f.a,"binary"),Buffer.from([0,1,2,3]));
    expect(await f.service.readText("a","text.txt",{maxBytes:4})).toMatchObject({content:"你",truncated:true,encoding:"utf-8"});
    await expect(f.service.readText("a","binary")).rejects.toMatchObject({code:"file_not_text"});
    await expect(f.service.stat("a","missing")).rejects.toMatchObject({code:"file_not_found"});
    await expect(f.service.readText("a","../b/hello.txt")).rejects.toMatchObject({code:"file_invalid_request"});
    await expect(f.service.list("unknown")).rejects.toMatchObject({code:"file_not_found"});
  });
  it("returns bounded results and treats search text literally", async () => {
    const f = await fixture();
    for (const name of ["a.txt","b.txt","c.txt"]) await writeFile(join(f.a,name),"a.*b\nAXXB\n");
    expect(await f.service.list("a",{limit:1})).toMatchObject({entries:[expect.any(Object)],truncated:true});
    expect(await f.service.find("a",{pattern:"*.txt",limit:1})).toMatchObject({files:["a.txt"],truncated:true});
    expect(await f.service.search("a",{query:"a.*b",limit:1})).toMatchObject({matches:[{path:"a.txt",line:1,text:"a.*b"}],truncated:true});
  });
  it("rejects pre-cancellation without acquiring resources and releases the lease after failures", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.service.list("a",{signal:controller.signal})).rejects.toMatchObject({code:"file_cancelled"});
    expect(f.acquired).not.toHaveBeenCalled();
    await expect(f.service.stat("a","missing")).rejects.toMatchObject({code:"file_not_found"});
    expect(f.released).toHaveBeenCalledTimes(1);
    const barrier = f.gate.tryEnterBarrier({kind:"global"},()=>true);
    expect(barrier).toBeDefined();
    await expect(f.service.list("a")).rejects.toBeDefined();
    expect(f.acquired).toHaveBeenCalledTimes(1); barrier!.release();
  });
});
