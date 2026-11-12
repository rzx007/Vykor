import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const owned: string[] = [];
afterEach(async () => { for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  vi.resetModules();
  const api = await import("../paths.js");
  const homeDir = await mkdtemp(join(tmpdir(), "vykor-writer-")); owned.push(homeDir);
  const dataRoot = join(homeDir, "root");
  return { api: api as typeof api & Record<string, any>, homeDir, dataRoot };
}

it("rechecks the pending migration between initialization and writer admission", async () => {
  const { api, homeDir, dataRoot } = await fixture();
  await api.initializeDataRoot({ homeDir, explicitRoot: dataRoot, env: {} });
  await api.writeDataRootSelector(homeDir, { version: 1, dataRoot, pendingMigration: { id: "pending", journalPath: join(homeDir, "migration.json") } });
  await expect(api.acquireDataRootWriter({ homeDir, dataRoot, kind: "cli" })).rejects.toThrow(/migration/);
  await expect(readFile(join(dataRoot, "data/daemon/writers"))).rejects.toThrow();
}, 30000);

it("keeps delayed and asynchronous work busy until its existing writer exits under the held home lock", async () => {
  const { api, homeDir, dataRoot } = await fixture();
  const writer = await api.acquireDataRootWriter({ homeDir, dataRoot, kind: "desktop" });
  expect(await api.listDataRootWriters(dataRoot)).toMatchObject([{ pid: process.pid, kind: "desktop" }]);
  await api.withDataRootLock(homeDir, async () => {
    // A real delayed write owns the pre-existing lease; drain/release must not take this lock again.
    await new Promise(resolve => setTimeout(resolve, 15));
    await writeFile(join(dataRoot, "late-write.txt"), "flushed");
    await writer.release();
    expect(await api.listDataRootWriters(dataRoot)).toEqual([]);
  });
  expect(await readFile(join(dataRoot, "late-write.txt"), "utf8")).toBe("flushed");
}, 30000);

it("does not remove an altered lease or recreate a root during release", async () => {
  const { api, homeDir, dataRoot } = await fixture();
  const writer = await api.acquireDataRootWriter({ homeDir, dataRoot, kind: "sdk-control" });
  const leases = await api.listDataRootWriters(dataRoot);
  await writeFile(leases[0].path, JSON.stringify({ pid: process.pid, token: "someone-else", kind: "sdk-control" }));
  await expect(writer.release()).rejects.toThrow(/ownership/);
  expect(await readFile(leases[0].path, "utf8")).toContain("someone-else");
  await rm(dataRoot, { recursive: true });
  await expect(writer.release()).rejects.toThrow();
  await expect(readFile(dataRoot)).rejects.toThrow();
}, 30000);

it("rejects admission from a root moved after initialization", async () => {
  const { api, homeDir, dataRoot } = await fixture();
  await api.initializeDataRoot({ homeDir, explicitRoot: dataRoot, env: {} });
  await mkdir(join(dataRoot, "data/migrations"), { recursive: true });
  await writeFile(join(dataRoot, "data/migrations/moved-root.json"), "{}");
  await expect(api.acquireDataRootWriter({ homeDir, dataRoot, kind: "cli" })).rejects.toThrow(/moved/);
}, 30000);

it("keeps a process writer visible through later synchronous exit callbacks", async () => {
  const { api, homeDir, dataRoot } = await fixture(), marker = join(homeDir,"exiting");
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const script = `import { acquireDataRootWriter } from ${JSON.stringify(new URL("../paths.ts",import.meta.url).href)}; import {writeFileSync} from 'node:fs'; await acquireDataRootWriter(${JSON.stringify({homeDir,dataRoot,kind:"cli"})}); process.on('exit',()=>{writeFileSync(${JSON.stringify(marker)},'wait'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000); writeFileSync(${JSON.stringify(join(dataRoot,"final-write"))},'finished');});`;
  const child=spawn(process.execPath,["--import",loader,"--input-type=module","-e",script],{stdio:"ignore",windowsHide:true});
  const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
  try {
    for(let i=0;i<200;i++){if(await readFile(marker,"utf8").then(()=>true,()=>false))break;await new Promise(resolve=>setTimeout(resolve,10));}
    expect(await api.listDataRootWriters(dataRoot)).toMatchObject([{pid:child.pid,kind:"cli"}]);
    await exited;
    expect(await readFile(join(dataRoot,"final-write"),"utf8")).toBe("finished");
    expect(await api.listDataRootWriters(dataRoot)).toEqual([]);
  } finally {child.kill("SIGTERM");await exited;}
},10000);
