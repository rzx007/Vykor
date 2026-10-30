import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Settings } from "@vykor/host-config";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import { createSessionEnvironmentAcquirer } from "../../../runtime/session-execution-environment.js";
import { SessionFileService } from "../session-file-service.js";

const roots: string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(change:(files:any)=>void, settingsChange: Partial<Settings> = {}) {
  const root=await mkdtemp(join(tmpdir(),"session-scan-"));roots.push(root);
  const session:SessionRecord={id:"a",cwd:root,title:"",model:"test",metadata:{runtime:{model:"test"}},status:"idle",createdAt:1,updatedAt:1};
  const settings:Settings={model:"test",apiFormat:"openai",maxTurns:1,permission:{mode:"full_access"},agentEnvironment:{kind:"native"},sandbox:{enabled:false},...settingsChange};
  const service=new SessionFileService({getSession:()=>session,getSettings:()=>settings,
    readiness:()=>({phase:"ready",accepting:true}),enter:()=>({release(){}}),
    acquireEnvironment:async(record,config)=>{const env=await createSessionEnvironmentAcquirer()(record,config);change(env.files);return env;},
  });
  return {root,service};
}

describe("session bounded scans",()=>{
  it.each(["list","find","search"] as const)("%s refuses environments without bounded scanning rather than enumerating everything",async operation=>{
    const {service}=await fixture(files=>{files.scanDirectory=undefined;});
    const pending=operation==="list"?service.list("a"):operation==="find"?service.find("a",{pattern:"*"}):service.search("a",{query:"needle"});
    await expect(pending).rejects.toMatchObject({code:"file_not_supported"});
  });

  it("counts denied entries and lookahead probes against the same 4000-entry traversal budget",async()=>{
    let inspected=0;
    const scanned:string[]=[];
    const {root,service}=await fixture(files=>{
      files.scanDirectory=async(path:string,{maxEntries}: {maxEntries:number})=>{
        scanned.push(basename(path));
        if(path===root) {inspected+=2;return {entries:[{name:"left",isDirectory:true},{name:"right",isDirectory:true}],truncated:false};}
        const count=Math.min(2500,maxEntries);
        const truncated=count<2500;
        inspected+=count+Number(truncated);
        return {entries:Array.from({length:count},(_,index)=>({name:`denied-${index}`,isDirectory:false})),truncated};
      };
    },{permission:{mode:"full_access",pathRules:[{pattern:"**/denied-*",allow:false}]}});
    await mkdir(join(root,"left"));await mkdir(join(root,"right"));
    const result=await service.find("a",{pattern:"**/*"});
    expect(result).toMatchObject({files:[],truncated:true});
    expect(inspected).toBe(4000);
    expect(scanned).toEqual([basename(root),"left","right"]);
  });

  it("uses only the bounded set for listing even when entries cannot pass path validation",async()=>{
    let inspected=0;
    const {service}=await fixture(files=>{files.scanDirectory=async(_path:string,{maxEntries}: {maxEntries:number})=>{
      inspected=maxEntries+1;
      return {entries:Array.from({length:maxEntries},(_,index)=>({name:`bad\0${index}`,isDirectory:false})),truncated:true};
    };});
    expect(await service.list("a")).toMatchObject({entries:[],truncated:true});
    expect(inspected).toBe(4000);
  });
});
