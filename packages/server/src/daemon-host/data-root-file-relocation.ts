import { randomUUID, createHash } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertManagedPathBoundary, getProjectDirectoryKey, isWithinManagedPath, relocateManagedPath, resolveUserDataPaths, type ManagedPathMove, type PathRelocationReport } from "@vykor/host-config/paths";
import { relocateWorkflowSnapshotPaths } from "@vykor/coordinator/workflow-relocation";

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const requireObject = (value: unknown): Record<string, any> => { if (!object(value)) throw new Error("Invalid structured file"); return value; };
const report = (): PathRelocationReport => ({ changed: 0, unchangedExternal: 0, unsupported: [] });

function composer(value: Record<string, any>, path: (value: string) => string): void {
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Unknown business data record");
  const recovery = requireObject(value.value);
  if (recovery.version !== 1 || !object(recovery.drafts) || !Array.isArray(recovery.submissions)) throw new Error("Unknown composer recovery");
  const items = (values: unknown) => {
    if (!Array.isArray(values)) throw new Error("Invalid composer items");
    for (const item of values) {
      requireObject(item);
      if (item.type === "mention" || item.type === "skill") {
        if (typeof item.path !== "string") throw new Error("Invalid composer path");
        item.path = path(item.path);
      } else if (!["text", "context", "capability"].includes(item.type)) throw new Error("Unknown composer item");
    }
  };
  const document = (value: unknown) => { const doc = requireObject(value); if (doc.version !== 1) throw new Error("Unknown composer document"); items(doc.items); };
  for (const draft of Object.values(recovery.drafts)) document(requireObject(draft).document);
  for (const submission of recovery.submissions) { requireObject(submission); items(submission.items); if (submission.draftDocument) document(submission.draftDocument); }
  // Attachment cards are asset IDs in the current schema, not source file paths.
}

function gitSettings(value: Record<string, any>, path: (value: string) => string, moves: readonly ManagedPathMove[]): void {
  if (value.version !== 1 || !object(value.preferences) || !Array.isArray(value.worktrees)) throw new Error("Unknown Git settings");
  const manager = (base: string): string => {
    const before = join(base, "worktrees"), after = relocateManagedPath(before, moves);
    if (basename(after) !== "worktrees") throw new Error("Unknown worktree manager destination");
    return after === before ? base : dirname(after);
  };
  if (typeof value.preferences.worktreeRoot === "string") value.preferences.worktreeRoot = manager(value.preferences.worktreeRoot);
  for (const tree of value.worktrees) {
    requireObject(tree);
    if (typeof tree.path !== "string" || typeof tree.configDir !== "string" || typeof tree.projectPath !== "string") throw new Error("Invalid Git worktree record");
    const next = path(tree.path);
    if (next !== tree.path) {
      if (!isWithinManagedPath(tree.path, join(tree.configDir, "worktrees"))) throw new Error("Worktree is outside its registered manager");
      const configDir = manager(tree.configDir);
      if (configDir === tree.configDir || !isWithinManagedPath(next, join(configDir, "worktrees"))) throw new Error("Worktree manager mapping is missing");
      tree.path = next; tree.configDir = configDir;
    }
    // Final moves already exclude real projects; an owned main follows its proven workspace move.
    tree.projectPath = path(tree.projectPath);
  }
}

function settings(value: Record<string, any>, path: (value: string) => string): void {
  for (const [owner, key] of [[value.terminal, "localShell"], [value.agentEnvironment?.shell, "executable"]] as const) if (owner?.[key] !== undefined) {
    if (typeof owner[key] !== "string") throw new Error("Invalid shell executable");
    owner[key] = path(owner[key]);
  }
  if (value.permission?.pathRules !== undefined) {
    if (!Array.isArray(value.permission.pathRules)) throw new Error("Invalid path rules");
    for (const rule of value.permission.pathRules) {
      if (!object(rule) || typeof rule.pattern !== "string") throw new Error("Invalid path rule");
      rule.pattern = path(rule.pattern);
    }
  }
  if (value.mcpServers !== undefined) {
    for (const server of Object.values(requireObject(value.mcpServers))) {
      const config = requireObject(server);
      if (config.type === "stdio" && config.cwd !== undefined) {
        if (typeof config.cwd !== "string") throw new Error("Invalid MCP cwd");
        config.cwd = path(config.cwd);
      }
    }
  }
  const filesystem = value.sandbox?.filesystem;
  if (filesystem !== undefined) for (const key of ["allowRead", "denyRead", "allowWrite", "denyWrite", "extraAllowedRoots"]) {
    requireObject(filesystem);
    if (filesystem[key] !== undefined) {
      if (!Array.isArray(filesystem[key]) || !filesystem[key].every((item: unknown) => typeof item === "string")) throw new Error("Invalid sandbox roots");
      filesystem[key] = filesystem[key].map(path);
    }
  }
}

export interface DataRootFileRelocationInput {
  stagedRoot: string;
  targetRoot: string;
  moves: readonly ManagedPathMove[];
  /** Explicit physical directories of copied, managed .vykor/workflows repositories only. */
  workflowDirectories?: readonly string[];
  /** Extra copied managed project settings files; external project settings are never passed. */
  settingsPaths?: readonly string[];
}

/** Prepares all known JSON changes before writing. Nonempty unsupported prevents all writes. */
export async function relocateDataRootFiles(input: DataRootFileRelocationInput): Promise<PathRelocationReport> {
  const result = report(), paths = resolveUserDataPaths(input.stagedRoot);
  const pending: Array<{ file: string; content: string; mode: number }> = [];
  const path = (value: string) => { const next = relocateManagedPath(value, input.moves); if (next === value) result.unchangedExternal++; return next; };
  const prepare = async (file: string, table: string, transform: (raw: string, value: Record<string, any>) => string) => {
    await assertManagedPathBoundary(file, input.stagedRoot);
    let stat;
    try { stat = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Structured copy must be a regular file: ${file}`);
    let value: Record<string, any> | undefined;
    try {
      const raw = await readFile(file, "utf8"); value = requireObject(JSON.parse(raw));
      const content = transform(raw, value);
      if (content !== raw) pending.push({ file, content, mode: stat.mode });
    } catch { result.unsupported.push({ table, id: basename(file), ...(typeof value?.version === "number" ? { version: value.version } : {}) }); }
  };
  const json = (fn: (value: Record<string, any>) => void) => (raw: string, value: Record<string, any>) => { const before = JSON.stringify(value); fn(value); const after = JSON.stringify(value); return before === after ? raw : after; };
  await prepare(paths.composerRecoveryFilePath, "composer-recovery", json(value => composer(value, path)));
  await prepare(paths.gitSettingsFilePath, "git-settings", json(value => gitSettings(value, path, input.moves)));
  for (const file of new Set([join(input.stagedRoot, "settings.json"), ...(input.settingsPaths ?? [])])) await prepare(file, "settings", json(value => settings(value, path)));
  for (const directory of new Set(input.workflowDirectories ?? [])) {
    await assertManagedPathBoundary(directory, input.stagedRoot);
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.name.endsWith(".json")) {
      await prepare(join(directory, entry.name), "workflow-file", (raw, value) => {
        if (value.status === "completed" || value.status === "failed") return raw;
        if (value.runId !== entry.name.slice(0, -5)) throw new Error("Workflow identity mismatch");
        return relocateWorkflowSnapshotPaths(raw, path);
      });
    }
  }
  if (result.unsupported.length) return result;
  for (const item of pending) {
    const temp = `${item.file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, item.content, { flag: "wx", mode: item.mode }); await rename(temp, item.file); result.changed++; }
    finally { await rm(temp, { force: true }); }
  }
  return result;
}

/** Hash directory keys use the same normalization as their regular writers. Never reads active roots. */
export async function relocateProjectStorageKeys(input: { stagedRoot: string; cwdPaths: readonly string[]; moves: readonly ManagedPathMove[] }): Promise<PathRelocationReport> {
  const result = report(), paths = resolveUserDataPaths(input.stagedRoot), pending = new Map<string, string>();
  const signature = async (directory: string): Promise<string> => {
    await assertManagedPathBoundary(directory, input.stagedRoot);
    const hash = createHash("sha256");
    const visit = async (path: string, name: string) => {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Project storage key contains a link: ${path}`);
      hash.update(JSON.stringify([name, stat.isDirectory() ? "directory" : "file"]));
      if (stat.isDirectory()) for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), `${name}/${entry}`);
      else if (stat.isFile()) hash.update(await readFile(path));
      else throw new Error(`Unsupported project storage file: ${path}`);
    };
    await visit(directory, ""); return hash.digest("hex");
  };
  const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
  for (const cwd of new Set(input.cwdPaths)) {
    const next = relocateManagedPath(cwd, input.moves);
    if (next === cwd) { result.unchangedExternal++; continue; }
    for (const [base, folded] of [[paths.localRulesDir, false], [paths.userMemoryDir, true], [paths.sessionMemoryDir, false]] as const) {
      const from = join(base, getProjectDirectoryKey(cwd, folded)), to = join(base, getProjectDirectoryKey(next, folded));
      if (from === to || !await exists(from)) continue;
      const digest = await signature(from);
      await assertManagedPathBoundary(to, input.stagedRoot);
      if (await exists(to)) { if (digest !== await signature(to)) throw new Error(`Project storage key conflict: ${to}`); continue; }
      const previous = pending.get(to);
      if (previous && digest !== await signature(previous)) throw new Error(`Project storage key conflict: ${to}`);
      pending.set(to, from);
    }
  }
  for (const [to, from] of pending) { await rename(from, to); result.changed++; }
  return result;
}
