import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { mkdir, open, readdir, lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { securePrivateDirectory, securePrivateFile } from "./private-file-permissions.js";
import { requireCompleteAbsolutePath, resolveManagedRealPath } from "./managed-path-relocation.js";
import { withDataRootLock } from "./data-root-selection.js";

export type DataRootWriterKind = "desktop" | "cli" | "daemon" | "sdk-control";
export interface DataRootWriter { pid: number; token: string; kind: DataRootWriterKind; path: string }
export interface DataRootWriterLease { release(): Promise<void> }
const kinds: DataRootWriterKind[] = ["desktop", "cli", "daemon", "sdk-control"];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const directory = (root: string) => join(root, "data", "daemon", "writers");

function readWriter(path: string): DataRootWriter {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Cannot verify data root writer ownership");
  let value: any;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error; throw new Error("Cannot verify data root writer ownership"); }
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !uuid.test(value.token) || !kinds.includes(value.kind)) throw new Error("Cannot verify data root writer ownership");
  return { pid: value.pid, token: value.token, kind: value.kind, path };
}

/** Root-local process ownership. Existing owners drain without reacquiring the home lock. */
export async function acquireDataRootWriter(input: {
  homeDir: string; dataRoot: string; kind: DataRootWriterKind; timeoutMs?: number; deadline?: number; signal?: AbortSignal;
}): Promise<DataRootWriterLease> {
  const deadline = input.deadline ?? (input.timeoutMs === undefined ? undefined : Date.now() + input.timeoutMs);
  const checkWaiting = () => {
    input.signal?.throwIfAborted();
    if (deadline !== undefined && Date.now() >= deadline) throw new Error("Data root writer admission timed out.");
  };
  checkWaiting();
  const root = requireCompleteAbsolutePath(input.dataRoot, "writer root");
  if (!kinds.includes(input.kind)) throw new Error("Invalid data root writer kind");
  return withDataRootLock(input.homeDir, async lock => {
    checkWaiting();
    lock.assertWritableRoot(root);
    if (relative(await resolveManagedRealPath(root), root) !== "") throw new Error("Data root writer directory is an alias");
    const dir = directory(root);
    if (relative(await resolveManagedRealPath(dir), dir) !== "") throw new Error("Data root writer directory is an alias");
    await mkdir(dir, { recursive: true, mode: 0o700 }); await securePrivateDirectory(dir);
    checkWaiting();
    const token = randomUUID(), path = join(dir, `${token}.json`);
    const handle = await open(path, "wx", 0o600);
    try { await securePrivateFile(path); await handle.writeFile(JSON.stringify({ pid: process.pid, token, kind: input.kind })); await handle.sync(); }
    finally { await handle.close(); }
    let released = false;
    const release = () => {
      if (released) return;
      if (relative(realpathSync(dir), resolve(dir)) !== "") throw new Error("Data root writer ownership directory changed");
      const owner = readWriter(path);
      if (owner.pid !== process.pid || owner.token !== token || owner.kind !== input.kind) throw new Error("Data root writer ownership changed");
      unlinkSync(path); released = true;
    };
    try { checkWaiting(); } catch (error) { release(); throw error; }
    // Keep lifetime records through every later synchronous exit handler. Only
    // ESRCH in the reader proves that a process cannot still write during exit.
    return { async release() { release(); } };
  }, { deadline, signal: input.signal });
}

/** Read-only inventory. Malformed or unknown ownership is busy, never presumed dead. */
export async function listDataRootWriters(dataRoot: string): Promise<DataRootWriter[]> {
  const dir = directory(requireCompleteAbsolutePath(dataRoot, "writer root"));
  let names: string[];
  try {
    const metadata = await lstat(dir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(await resolveManagedRealPath(dir), dir) !== "") throw new Error("Cannot verify data root writers directory");
    names = await readdir(dir);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const writers: DataRootWriter[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || !uuid.test(name.slice(0, -5))) throw new Error("Cannot verify data root writer ownership");
    let owner: DataRootWriter;
    try { owner = readWriter(join(dir, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (owner.token !== name.slice(0, -5)) throw new Error("Cannot verify data root writer ownership");
    try { process.kill(owner.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; }
    writers.push(owner);
  }
  return writers;
}
