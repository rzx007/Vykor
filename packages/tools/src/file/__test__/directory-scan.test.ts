import filesystem from "node:fs/promises";
import type { Dir } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findPosixShell } from "../../../../../tests/helpers/posix-shell.js";
import { HostFileOperations, WslFileOperations } from "../operations.js";

const roots: string[] = [];
const shell = findPosixShell();
const nativeNulScan=!!shell && spawnSync(shell,["-c","/usr/bin/ls --zero -d -- /"],{stdio:"ignore",windowsHide:true,timeout:5000}).status===0;
const wslDistribution=!nativeNulScan && process.platform==="win32" ? findWslScanDistribution() : undefined;
const wslNulScan=!!wslDistribution;
const realScanAvailable=nativeNulScan || wslNulScan;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => filesystem.rm(root, {recursive:true,force:true})));
});
async function directory() {
  const root = await filesystem.mkdtemp(join(tmpdir(), "vk-directory-scan-")); roots.push(root); return root;
}

describe("bounded directory scans", () => {
  it("stops host enumeration after one lookahead entry and closes the directory", async () => {
    const root = await directory();
    await Promise.all(Array.from({length:1000}, (_,index) => filesystem.writeFile(join(root,`entry-${index}`),"")));
    const openDirectory = filesystem.opendir;
    let opened: Dir | undefined;
    let reads = 0;
    vi.spyOn(filesystem,"opendir").mockImplementation(async (path, options) => {
      const handle = await openDirectory(path,options); opened = handle;
      const read = handle.read.bind(handle);
      vi.spyOn(handle,"read").mockImplementation(async () => { reads++; return read(); });
      return handle;
    });

    const result = await (new HostFileOperations() as any).scanDirectory(root,{maxEntries:2});
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(reads).toBe(3);
    await expect(opened!.read()).rejects.toMatchObject({code:"ERR_DIR_CLOSED"});
  });

  it("closes a host directory before reporting cancellation during enumeration", async () => {
    const root = await directory(); await filesystem.writeFile(join(root,"entry"),"");
    const controller = new AbortController();
    const openDirectory = filesystem.opendir;
    let opened: Dir | undefined;
    vi.spyOn(filesystem,"opendir").mockImplementation(async (path, options) => {
      const handle = await openDirectory(path,options); opened = handle;
      const read = handle.read.bind(handle);
      vi.spyOn(handle,"read").mockImplementation(async () => { const entry=await read(); controller.abort(); return entry; });
      return handle;
    });
    await expect((new HostFileOperations() as any).scanDirectory(root,{maxEntries:2,signal:controller.signal}))
      .rejects.toMatchObject({name:"AbortError"});
    await expect(opened!.read()).rejects.toMatchObject({code:"ERR_DIR_CLOSED"});
  });

  it("supports an empty scan budget and distinguishes an exact fit from truncation", async () => {
    const root = await directory();
    const files = new HostFileOperations() as any;
    expect(await files.scanDirectory(root,{maxEntries:0})).toEqual({entries:[],truncated:false});
    await filesystem.mkdir(join(root,"sub"));
    expect(await files.scanDirectory(root,{maxEntries:0})).toEqual({entries:[],truncated:true});
    expect(await files.scanDirectory(root,{maxEntries:1})).toEqual({entries:[{name:"sub",isDirectory:true}],truncated:false});
    const controller=new AbortController();controller.abort();
    await expect(files.scanDirectory("missing",{maxEntries:1,signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});
    await expect(files.scanDirectory(root,{maxEntries:-1})).rejects.toBeInstanceOf(RangeError);
  });

  it.skipIf(!realScanAvailable)("executes the WSL script with a bounded NUL stream and preserves directory and link names", async () => {
    const root = await directory();
    const path = executionPath(root);
    await filesystem.writeFile(join(root,"a; echo injected"),"");
    await filesystem.writeFile(join(root,".hidden"),"");
    await filesystem.mkdir(join(root,"folder"));
    await filesystem.symlink(join(root,"folder"),join(root,"link"),process.platform==="win32"?"junction":"dir");
    const files = realShellOperations();
    const all = await files.scanDirectory(path,{maxEntries:4});
    expect(all.truncated).toBe(false);
    expect(all.entries.sort((a:any,b:any)=>a.name.localeCompare(b.name))).toEqual([
      {name:".hidden",isDirectory:false},{name:"a; echo injected",isDirectory:false},{name:"folder",isDirectory:true},{name:"link",isDirectory:false},
    ]);
    await expect(files.scanDirectory(`${path}/missing`,{maxEntries:1})).rejects.toThrow();
    await expect(files.scanDirectory(`${path}/a; echo injected`,{maxEntries:1})).rejects.toThrow();
    expect(await files.scanDirectory(path,{maxEntries:0})).toEqual({entries:[],truncated:true});
  });

  it.skipIf(!realScanAvailable)("accepts the WSL producer's normal SIGPIPE when a large directory exceeds the limit", async () => {
    const root = await directory();
    await Promise.all(Array.from({length:1500},(_,index)=>filesystem.writeFile(join(root,`${String(index).padStart(4,"0")}-${"x".repeat(120)}`),"")));
    const result = await realShellOperations().scanDirectory(executionPath(root),{maxEntries:2});
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it.skipIf(!realScanAvailable).each([false,true])("stops the WSL producer instead of collecting every entry before truncating (POSIX wrapper: %s)", async posixWrapper => {
    const root=await directory();
    const progress=join(root,"progress"), initialization=join(root,"initialize.sh");
    // A controlled stream at the external program boundary records how far the real pipeline reads.
    await filesystem.writeFile(initialization,`function /usr/bin/ls {
      trap 'exit 141' PIPE
      for ((index=0;index<5000;index++)); do
        printf '%0128d\\0' "$index" || return
        printf x >> "$SCAN_PROGRESS"
      done
    }`);
    let outputBytes=0;
    const files=realShellOperations({
      initialization:executionPath(initialization),posixWrapper,
      env:{SCAN_PROGRESS:executionPath(progress)},
      output:bytes=>{outputBytes=bytes.byteLength;},
    });
    const result=await files.scanDirectory(executionPath(root),{maxEntries:2});
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(outputBytes).toBe(387);
    expect((await filesystem.readFile(progress)).byteLength).toBeLessThan(5000);
  });

  it("forwards WSL cancellation and waits for process cleanup before rejecting", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let cleaned=false;
    const files = new WslFileOperations({workspace:{executionRoot:"/workspace"},process:{
      async execProcess(_argv: string[], options: {signal?:AbortSignal}) {
        received=options.signal;
        return {write() {},end() {},onOutput() {return ()=>{};},
          async wait() { controller.abort(); await Promise.resolve(); cleaned=true;return {exitCode:143}; }};
      },
    }} as any) as any;
    await expect(files.scanDirectory("/workspace",{maxEntries:2,signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});
    expect(received).toBe(controller.signal);
    expect(cleaned).toBe(true);
  });

  it("reports an unsupported WSL scan runtime with a structured error", async () => {
    const files=new WslFileOperations({workspace:{executionRoot:"/workspace"},process:{
      async execProcess() {return {write(){},end(){},onOutput(){return ()=>{};},async wait(){return {exitCode:95};}};},
    }} as any) as any;
    await expect(files.scanDirectory("/workspace",{maxEntries:2})).rejects.toMatchObject({code:"ENOTSUP"});
  });

  it.skipIf(!shell || nativeNulScan)("reports old coreutils as unsupported using the actual fixed script", async () => {
    const root=await directory();
    await expect(realShellOperations({native:true}).scanDirectory(root.replaceAll("\\","/"),{maxEntries:2}))
      .rejects.toMatchObject({code:"ENOTSUP"});
  });
});

function realShellOperations(options: {native?:boolean;initialization?:string;posixWrapper?:boolean;env?:Record<string,string>;output?:(bytes:Uint8Array)=>void} = {}): any {
  return new WslFileOperations({workspace:{executionRoot:"/"},process:{
    async execProcess(argv: string[]) {
      // Load the producer mock in the same Bash process as the fixed script, without relying on BASH_ENV startup behavior.
      const initialized=options.initialization
        ? [argv[0]!,"-c",`. "$1"\nshift\n${argv[2]}`,argv[3]!,options.initialization,...argv.slice(4)]
        : argv;
      const command=options.posixWrapper
        ? ["/bin/sh","-c",'exec /bin/bash "$@"',"vk-script-test",...initialized.slice(1)]
        : initialized;
      // Git for Windows may ship old coreutils; use a supported default WSL installation when available.
      const result=nativeNulScan || options.native
        ? spawnSync(shell!,["-c",'exec "$@"',"vk-script-test",...command],{windowsHide:true,env:{...process.env,...options.env}})
        : spawnSync("wsl.exe",["--distribution",wslDistribution!,"--exec","/usr/bin/env",...Object.entries(options.env ?? {}).map(([key,value])=>`${key}=${value}`),...command],{windowsHide:true});
      if(result.error) throw result.error;
      options.output?.(result.stdout);
      return {write() {},end() {},onOutput(listener:(chunk:Uint8Array)=>void) {listener(result.stdout);return ()=>{};},
        onErrorOutput(listener:(chunk:Uint8Array)=>void) {listener(result.stderr);return ()=>{};},async wait() {return {exitCode:result.status ?? 1};}};
    },
  }} as any);
}

function executionPath(path:string):string {
  if (!wslNulScan) return path.replaceAll("\\","/");
  const converted=spawnSync("wsl.exe",["--distribution",wslDistribution!,"--exec","/usr/bin/wslpath","-a","-u",path],{encoding:"utf8",windowsHide:true});
  if (converted.status!==0) throw new Error(converted.stderr);
  return converted.stdout.trim();
}

function findWslScanDistribution():string|undefined {
  const distributions=spawnSync("wsl.exe",["--list","--quiet"],{encoding:"utf16le",windowsHide:true,timeout:15000});
  if (distributions.status!==0) return undefined;
  return distributions.stdout.replaceAll("\u0000","").replace("\uFEFF","").split(/\r?\n/).map(value=>value.trim()).filter(Boolean).find(name=>
    spawnSync("wsl.exe",["--distribution",name,"--exec","/usr/bin/ls","--zero","-d","--","/"],{stdio:"ignore",windowsHide:true,timeout:15000}).status===0,
  );
}
