import { posix } from "node:path";
import type { ExecutionEnvironmentHandle, EnvironmentFileStat } from "@vykor/environment";
import { normalizeApprovalMode, type Settings } from "@vykor/host-config";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import { settingsForApprovalMode } from "@vykor/sandbox";
import { globToRegex, isBinaryContent } from "@vykor/tools";
import {
  SessionFileError, parseSessionFileListInput, parseSessionFileStatInput, parseSessionFileReadInput,
  parseSessionFileFindInput, parseSessionFileSearchInput,
  type SessionFileInfo, type SessionDirectoryResult, type SessionTextFileResult,
  type SessionFindFilesResult, type SessionSearchFilesResult, type SessionFileSearchMatch,
  type SessionFileListInput, type SessionFileFindInput, type SessionFileSearchInput,
} from "@vykor/domain-contracts/files";
import { readSessionRuntimeConfig } from "../session/configuration/runtime-configuration.js";
import { createSessionFileAccess } from "./file-access.js";

type Options<T = object> = T & { signal?: AbortSignal };
type Tool = "Read" | "Glob" | "Grep";
interface Request {
  environment: ExecutionEnvironmentHandle;
  access: Awaited<ReturnType<typeof createSessionFileAccess>>;
  signal: AbortSignal;
  timedOut(): boolean;
}
interface Budget { visited: number; bytes: number; truncated: boolean }
export interface SessionFileServiceContext {
  getSession(sessionId: string): SessionRecord | undefined;
  getSettings(session: SessionRecord): Settings | Promise<Settings>;
  acquireEnvironment(session: SessionRecord, settings: Settings): Promise<ExecutionEnvironmentHandle>;
  enter(scope: {sessionId: string; cwd: string}): {release(): void};
  readiness(): {phase: string; accepting: boolean};
  timeoutMs?: number;
}
const TEXT_BYTES = 256 * 1024;
const SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_VISITED = 4000;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".venv", "venv", "__pycache__", "coverage", "out"]);

/** Stateless, session-scoped read facade; the environment owns all actual I/O. */
export class SessionFileService {
  constructor(private readonly context: SessionFileServiceContext) {}

  async list(sessionId: string, options: Options<SessionFileListInput> = {}): Promise<SessionDirectoryResult> {
    const {signal, ...query} = options;
    const {path = ".", limit = 200} = parseSessionFileListInput(query);
    return this.request(sessionId, signal, async request => {
      const directory = await request.access.authorize(path, "Read", request.signal);
      await requireDirectory(request, directory.executionPath);
      const children = await request.environment.files.listDir(directory.executionPath, request.signal);
      children.sort((a,b) => Number(b.isDirectory)-Number(a.isDirectory) || a.name.localeCompare(b.name));
      const entries: SessionFileInfo[] = [];
      let visited = 0, truncated = false;
      for (const child of children) {
        if (++visited > MAX_VISITED) { truncated = true; break; }
        const relativePath = posix.join(directory.relativePath, child.name);
        const candidate = await this.candidate(request, relativePath, "Read");
        if (!candidate) continue;
        if (entries.length >= limit) { truncated = true; break; }
        entries.push(fileInfo(candidate.path, candidate.stat));
      }
      return {path:directory.relativePath, entries, truncated};
    });
  }

  async stat(sessionId: string, path: string, options: Options = {}): Promise<SessionFileInfo> {
    const input = parseSessionFileStatInput({path});
    return this.request(sessionId, options.signal, async request => {
      const target = await request.access.authorize(input.path, "Read", request.signal);
      return fileInfo(target.relativePath, await request.environment.files.stat(target.sourcePath, request.signal));
    });
  }

  async readText(sessionId: string, path: string, options: Options<{maxBytes?:number}> = {}): Promise<SessionTextFileResult> {
    const {signal,...query} = options;
    const input = parseSessionFileReadInput({...query,path});
    return this.request(sessionId, signal, async request => {
      const target = await request.access.authorize(input.path, "Read", request.signal);
      const {bytesRead: _bytesRead, ...text} = await readText(request, target.executionPath, input.maxBytes ?? TEXT_BYTES);
      return {path:target.relativePath, ...text};
    });
  }

  async find(sessionId: string, options: Options<SessionFileFindInput>): Promise<SessionFindFilesResult> {
    const {signal,...query} = options;
    const {path=".",pattern,limit=100} = parseSessionFileFindInput(query);
    return this.request(sessionId, signal, async request => {
      const root = await request.access.authorize(path,"Glob",request.signal);
      await requireDirectory(request,root.executionPath);
      const budget: Budget = {visited:0,bytes:0,truncated:false};
      const matches = compileGlob(pattern);
      const files: string[] = [];
      try {
        for await (const file of this.walk(request,root.relativePath,"Glob",budget)) {
          const fromRoot = posix.relative(root.relativePath,file.path);
          if (!matches(fromRoot)) continue;
          files.push(file.path);
          if (files.length >= limit) { budget.truncated=true; break; }
        }
      } catch(error) { if (request.timedOut()) budget.truncated=true; else throw error; }
      return {path:root.relativePath,files,truncated:budget.truncated};
    }, true);
  }

  async search(sessionId: string, options: Options<SessionFileSearchInput>): Promise<SessionSearchFilesResult> {
    const {signal,...query} = options;
    const {path=".",query:needle,include,caseSensitive=false,limit=100} = parseSessionFileSearchInput(query);
    return this.request(sessionId, signal, async request => {
      const root = await request.access.authorize(path,"Grep",request.signal);
      await requireDirectory(request,root.executionPath);
      const budget: Budget = {visited:0,bytes:0,truncated:false};
      const matches: SessionFileSearchMatch[] = [];
      const includes = include ? compileGlob(include) : () => true;
      const target = caseSensitive ? needle : needle.toLowerCase();
      try {
        for await (const file of this.walk(request,root.relativePath,"Grep",budget)) {
          if (!includes(posix.relative(root.relativePath,file.path))) continue;
          const remaining = SEARCH_BYTES-budget.bytes;
          if (remaining <= 1) { budget.truncated=true; break; }
          const maxBytes = Math.min(TEXT_BYTES,remaining-1);
          let read;
          try { read = await readText(request,file.executionPath,maxBytes,bytes => { budget.bytes += bytes; }); }
          catch(error) { if (isFileError(error,"file_not_text")) continue; throw error; }
          budget.truncated ||= read.truncated;
          const lines = read.content.split(/\r?\n/);
          for (let index=0;index<lines.length;index++) {
            request.signal.throwIfAborted();
            const line = lines[index]!;
            const found = (caseSensitive ? line : line.toLowerCase()).indexOf(target);
            if (found < 0) continue;
            const start = Math.max(0,found-160);
            matches.push({path:file.path,line:index+1,text:line.slice(start,start+4096)});
            if (start > 0 || line.length > start+4096) budget.truncated=true;
            if (matches.length >= limit) return {path:root.relativePath,matches,truncated:true};
          }
        }
      } catch(error) { if (request.timedOut()) budget.truncated=true; else throw error; }
      return {path:root.relativePath,matches,truncated:budget.truncated};
    }, true);
  }

  private async *walk(request:Request, root:string, tool:Tool, budget:Budget): AsyncIterable<{path:string;executionPath:string}> {
    const pending = [root];
    while (pending.length) {
      request.signal.throwIfAborted();
      const current = pending.pop()!;
      const directory = await request.access.authorize(current,tool,request.signal);
      const entries = await request.environment.files.listDir(directory.executionPath,request.signal);
      entries.sort((a,b) => a.name.localeCompare(b.name));
      const directories: string[] = [];
      for (const entry of entries) {
        request.signal.throwIfAborted();
        if (++budget.visited > MAX_VISITED) { budget.truncated=true; return; }
        if (entry.isDirectory && SKIP_DIRECTORIES.has(entry.name)) continue;
        const candidate = await this.candidate(request,posix.join(directory.relativePath,entry.name),tool);
        if (!candidate) continue;
        // Directory entries identify links without following them. Never recurse through a directory link.
        if (candidate.stat.isDirectory && entry.isDirectory && !candidate.stat.isSymbolicLink) directories.push(candidate.path);
        else if (candidate.stat.isFile) yield {path:candidate.path,executionPath:candidate.executionPath};
      }
      pending.push(...directories.reverse());
    }
  }

  private async candidate(request:Request,path:string,tool:Tool) {
    try {
      const target = await request.access.authorize(path,tool,request.signal);
      const stat = await request.environment.files.stat(target.sourcePath,request.signal);
      return {path:target.relativePath,executionPath:target.executionPath,stat};
    } catch(error) {
      if (isFileError(error,"file_forbidden") || isFileError(error,"file_not_found") || isMissing(error)) return undefined;
      throw error;
    }
  }

  private async request<T>(sessionId:string, signal:AbortSignal|undefined, work:(request:Request)=>Promise<T>, partialTimeout=false): Promise<T> {
    if (signal?.aborted) throw new SessionFileError("file_cancelled","File request was cancelled");
    const readiness=this.context.readiness();
    if (readiness.phase!=="ready" || !readiness.accepting) throw new SessionFileError("file_not_ready","File service is not ready");
    const session=this.context.getSession(sessionId);
    if (!session) throw new SessionFileError("file_not_found","Session not found");
    let lease;
    try { lease=this.context.enter({sessionId:session.id,cwd:session.cwd}); }
    catch { throw new SessionFileError("file_not_ready","Workspace is unavailable during maintenance"); }
    const controller = new AbortController();
    const onAbort=()=>controller.abort(signal?.reason);
    signal?.addEventListener("abort",onAbort,{once:true});
    let timeout=false;
    const timer=setTimeout(()=>{timeout=true;controller.abort(new SessionFileError("file_timeout","File request timed out"));},this.context.timeoutMs ?? 10_000);
    timer.unref?.();
    let environment:ExecutionEnvironmentHandle|undefined;
    try {
      let settings=await this.context.getSettings(session);
      controller.signal.throwIfAborted();
      const runtime=readSessionRuntimeConfig(session,{approvalMode:normalizeApprovalMode(settings.permission.mode)});
      const approvalMode=runtime.approvalMode ?? normalizeApprovalMode(settings.permission.mode) ?? "ask";
      settings=settingsForApprovalMode({...settings,permission:{...settings.permission,mode:approvalMode,
        ...(runtime.allowedTools ? {allowedTools:runtime.allowedTools} : {}),
        deniedTools:[...(settings.permission.deniedTools ?? []),...(runtime.disallowedTools ?? [])],
      }},approvalMode);
      environment=await this.context.acquireEnvironment(session,settings);
      controller.signal.throwIfAborted();
      const access=await createSessionFileAccess(environment,settings);
      const result=await work({environment,access,signal:controller.signal,timedOut:()=>timeout && !signal?.aborted});
      if (signal?.aborted || (controller.signal.aborted && !partialTimeout)) controller.signal.throwIfAborted();
      return result;
    } catch(error) {
      if (signal?.aborted) throw new SessionFileError("file_cancelled","File request was cancelled");
      if (timeout) throw new SessionFileError("file_timeout","File request timed out");
      if (error instanceof SessionFileError) throw error;
      if (isMissing(error)) throw new SessionFileError("file_not_found","Workspace path not found");
      if (hasCode(error,"EACCES") || hasCode(error,"EPERM")) throw new SessionFileError("file_forbidden","Workspace path cannot be read");
      throw new SessionFileError("file_operation_failed","File operation failed");
    } finally {
      try { await environment?.release(); }
      finally { clearTimeout(timer);signal?.removeEventListener("abort",onAbort);lease.release(); }
    }
  }
}

async function requireDirectory(request:Request,path:string) {
  const stat=await request.environment.files.stat(path,request.signal);
  if (!stat.isDirectory) throw new SessionFileError("file_invalid_request","Expected a workspace directory");
}
async function readText(request:Request,path:string,maxBytes:number,onRead?:(bytes:number)=>void) {
  const stat=await request.environment.files.stat(path,request.signal);
  if (!stat.isFile) throw new SessionFileError("file_not_text","Expected a regular UTF-8 text file");
  const bytes=await request.environment.files.readBytes(path,{maxBytes:maxBytes+1,signal:request.signal});
  onRead?.(bytes.byteLength);
  request.signal.throwIfAborted();
  const truncated=bytes.byteLength>maxBytes;
  let content:string;
  try { content=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,maxBytes),{stream:truncated}); }
  catch { throw new SessionFileError("file_not_text","File is not UTF-8 text"); }
  if (isBinaryContent(content)) throw new SessionFileError("file_not_text","File is not UTF-8 text");
  return {content,encoding:"utf-8" as const,truncated,bytesRead:bytes.byteLength};
}
function fileInfo(path:string,stat:EnvironmentFileStat):SessionFileInfo {
  return {path,name:posix.basename(path),kind:stat.isSymbolicLink?"symlink":stat.isDirectory?"directory":stat.isFile?"file":"other",
    ...(stat.sizeBytes!==undefined?{sizeBytes:stat.sizeBytes}:{}),...(stat.modifiedAt!==undefined?{modifiedAt:stat.modifiedAt}:{})};
}
function compileGlob(pattern:string):(path:string)=>boolean {
  let expression:RegExp;
  try { expression=globToRegex(pattern); }
  catch { throw new SessionFileError("file_invalid_request","Invalid file pattern"); }
  return path=>expression.test(path) || !pattern.includes("/") && expression.test(posix.basename(path));
}
function hasCode(error:unknown,code:string):boolean { return !!error && typeof error==="object" && "code" in error && error.code===code; }
function isMissing(error:unknown):boolean {return hasCode(error,"ENOENT") || hasCode(error,"ENOTDIR");}
function isFileError(error:unknown,code:string):boolean {return error instanceof SessionFileError && error.code===code;}
