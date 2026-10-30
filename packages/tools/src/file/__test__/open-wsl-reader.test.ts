import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { EnvironmentProcess, EnvironmentProcessOptions, ExecutionEnvironmentHandle } from "@vykor/environment";
import { createExecutionEnvironment } from "@vykor/sandbox";
import { WslFileOperations } from "../operations.js";

const windows = process.platform === "win32";
const command = windows ? "wsl.exe" : "/bin/sh";
const distributions = windows ? spawnSync(command, ["--list", "--quiet"], {windowsHide:true,timeout:15000}).stdout?.toString("utf16le").split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
const distribution = distributions?.find(value => /ubuntu/i.test(value));
const prefix = windows ? [...(distribution ? ["--distribution", distribution] : []), "--exec"] : [];
const supported = (windows || process.platform === "linux") && spawnSync(command,
  [...prefix, ...(windows ? ["/bin/sh"] : []), "-c", "test -d /proc/self/fd"],
  { windowsHide: true, timeout: 15000 }).status === 0;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const executionPath = (path: string) => windows ? path.replace(/^([a-z]):/i, (_, drive: string) => `/mnt/${drive.toLowerCase()}`).replaceAll("\\", "/") : path;

async function environment(root: string): Promise<ExecutionEnvironmentHandle> {
  if (windows) return createExecutionEnvironment({
    config: {mode:"wsl",kind:"wsl",failClosed:true,cwd:root,sandbox:{} as any},
    settings: {model:"test",apiFormat:"openai",maxTurns:1,permission:{mode:"full_access"},agentEnvironment:{kind:"wsl",distribution}},
    binding: {kind:"wsl",hostRoot:root,executionRoot:executionPath(root)}, sessionId:"held-reader",userSkillsRoot:root,
  }, {preflightWsl:async()=>({homeDir:"/tmp"})});
  return { workspace: { executionRoot: executionPath(root) }, process: {
    async execProcess(argv: string[], options?: EnvironmentProcessOptions): Promise<EnvironmentProcess> {
      const child = spawn(windows ? command : argv[0]!, windows ? [...prefix, ...argv] : argv.slice(1), { windowsHide: true, signal: options?.signal });
      const exit = new Promise<{exitCode:number|null}>((resolve, reject) => { child.once("error", reject); child.once("close", exitCode => resolve({exitCode})); });
      child.stdin.on("error", () => {});
      return {
        write: data => { child.stdin.write(data); }, end: () => child.stdin.end(),
        onOutput: listener => { child.stdout.on("data", listener); return () => { child.stdout.off("data", listener); }; },
        onErrorOutput: listener => { child.stderr.on("data", listener); return () => { child.stderr.off("data", listener); }; },
        wait: () => exit, signal: async () => { child.kill(); },
      };
    },
  } } as ExecutionEnvironmentHandle;
}

it.skipIf(!supported)("reads the same WSL object after its directory alias is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-wsl-open-")); roots.push(root);
  for (const directory of ["inside", "outside"]) await mkdir(join(root, directory));
  await writeFile(join(root, "inside", "value.txt"), "INSIDE");
  await writeFile(join(root, "outside", "value.txt"), "OUTSIDE");
  const alias = join(root, "alias");
  await symlink(join(root, "inside"), alias, windows ? "junction" : "dir");
  const operations = new WslFileOperations(await environment(root));
  const path = executionPath(join(alias, "value.txt"));
  const reader = operations.openRead ? await operations.openRead(path) : {
    readBytes: (options: {maxBytes:number}) => operations.readBytes(path, options), close: async () => {},
  };
  try {
    await unlink(alias);
    await symlink(join(root, "outside"), alias, windows ? "junction" : "dir");
    expect(Buffer.from(await reader.readBytes({maxBytes:16})).toString()).toBe("INSIDE");
  } finally { await reader.close(); }
}, 20_000);

it.skipIf(!supported)("bounds one WSL read and preserves Unicode file metadata through the real executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-wsl-unicode-")); roots.push(root);
  const name = "中文-🙂.txt", path = join(root, name); await writeFile(path, "你好!");
  const reader = await new WslFileOperations(await environment(root)).openRead(executionPath(path), new AbortController().signal);
  try {
    expect(reader.canonicalPath).toContain(name);
    expect(reader.stat).toMatchObject({isFile:true,sizeBytes:7,modifiedAt:expect.any(Number)});
    expect(Buffer.from(await reader.readBytes({maxBytes:4}))).toEqual(Buffer.from([0xe4,0xbd,0xa0,0xe5]));
    await expect(reader.readBytes({maxBytes:4})).rejects.toThrow(/consumed|closed/);
  } finally { await reader.close(); await reader.close(); }
}, 20_000);

it.skipIf(!supported)("closes an unread WSL handle and retains the original process failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-wsl-unread-")); roots.push(root);
  const path = join(root,"value.txt"); await writeFile(path,"fixture");
  const env = await environment(root), execute = env.process.execProcess.bind(env.process);
  let exited = false;
  env.process.execProcess = async (...args) => {
    const process = await execute(...args);
    const exit = process.wait().then(() => { exited=true; throw new Error("fixture executor failure"); });
    return {...process,wait:()=>exit};
  };
  const reader = await new WslFileOperations(env).openRead(executionPath(path));
  await expect(reader.close()).resolves.toBeUndefined();
  expect(exited).toBe(true);
}, 20_000);

it.skipIf(!supported)("waits for a cancelled WSL file process to exit before close resolves", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-wsl-cancel-")); roots.push(root);
  const path = join(root,"value.txt"); await writeFile(path,"fixture");
  const controller = new AbortController(), env = await environment(root), execute = env.process.execProcess.bind(env.process);
  let exited = false;
  env.process.execProcess = async (...args) => {
    const process = await execute(...args), exit = process.wait().finally(() => {exited=true;});
    return {...process,wait:()=>exit};
  };
  const reader = await new WslFileOperations(env).openRead(executionPath(path),controller.signal);
  controller.abort();
  await expect(reader.readBytes({maxBytes:8,signal:controller.signal})).rejects.toMatchObject({name:"AbortError"});
  await reader.close(); expect(exited).toBe(true);
}, 20_000);

it.skipIf(!supported)("keeps WSL missing and non-file errors distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-wsl-invalid-")); roots.push(root);
  const operations = new WslFileOperations(await environment(root));
  await expect(operations.openRead(executionPath(join(root,"missing")))).rejects.toMatchObject({code:"ENOENT"});
  await expect(operations.openRead(executionPath(root))).rejects.toMatchObject({code:"EFTYPE"});
}, 20_000);

it.skipIf(!supported)("makes concurrent WSL closes wait for the same process cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-wsl-close-")); roots.push(root);
  const path = join(root,"value.txt"); await writeFile(path,"fixture");
  const env = await environment(root), execute = env.process.execProcess.bind(env.process);
  let observeExit!:()=>void, finishCleanup!:()=>void;
  const exited=new Promise<void>(resolve=>{observeExit=resolve;}), cleaned=new Promise<void>(resolve=>{finishCleanup=resolve;});
  env.process.execProcess = async (...args) => {
    const process=await execute(...args), exit=process.wait().then(async result=>{observeExit();await cleaned;return result;});
    return {...process,wait:()=>exit};
  };
  const reader=await new WslFileOperations(env).openRead(executionPath(path));
  const first=reader.close(); let secondSettled=false;
  const second=reader.close().then(()=>{secondSettled=true;});
  let premature=false;
  try { await exited;await new Promise<void>(resolve=>setImmediate(resolve));premature=secondSettled; }
  finally { finishCleanup();await Promise.all([first,second]); }
  expect(premature).toBe(false);
}, 20_000);
