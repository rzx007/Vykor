/** A bounded Git observation of the repository during a Run, not proof of authorship. */
export const WORKSPACE_CHANGE_MAX_FILES = 128;
export const WORKSPACE_CHANGE_MAX_PATH_LENGTH = 1024;
export const WORKSPACE_CHANGE_REASONS = [
  "not_git_repository", "preexisting_dirty_overlap", "non_linear_head_change",
  "post_commit_worktree_changed", "git_inspection_failed", "sensitive_content_path",
  "concurrent_run_overlap", "execution_environment_unavailable", "daemon_restarted",
  "observation_budget_exceeded", "observation_cancelled",
] as const;

export interface WorkspaceChangeFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";
  lines: number;
  /** 捕获时的增删拆分（lines = additions + deletions）。旧记录没有该字段，读取时按缺失处理。 */
  additions?: number;
  deletions?: number;
}

export interface WorkspaceChangesMetadata {
  version: 1;
  status: "captured" | "complete" | "unavailable";
  reason?: (typeof WORKSPACE_CHANGE_REASONS)[number];
  repositoryRoot?: string;
  files: WorkspaceChangeFile[];
  fileCount: number;
  totalLines: number;
  truncated: boolean;
}

export function readWorkspaceChangesMetadata(value: unknown): WorkspaceChangesMetadata | undefined {
  if (!record(value) || value.version !== 1 || typeof value.status !== "string" || !["captured", "complete", "unavailable"].includes(value.status)) return undefined;
  if (!Array.isArray(value.files) || value.files.length > WORKSPACE_CHANGE_MAX_FILES ||
    !count(value.fileCount) || !count(value.totalLines) || typeof value.truncated !== "boolean") return undefined;
  if (value.reason !== undefined && !WORKSPACE_CHANGE_REASONS.includes(value.reason as never)) return undefined;
  if (value.repositoryRoot !== undefined && !rootPath(value.repositoryRoot)) return undefined;
  if (value.status === "unavailable" && value.reason === undefined) return undefined;
  if (value.status !== "unavailable" && (value.reason !== undefined || value.repositoryRoot === undefined)) return undefined;
  const files: WorkspaceChangeFile[] = [];
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!record(file) || !relativePath(file.path) || paths.has(file.path) ||
      (file.oldPath !== undefined && !relativePath(file.oldPath)) || !count(file.lines) ||
      typeof file.status !== "string" || !["added", "modified", "deleted", "renamed", "copied", "unknown"].includes(file.status)) return undefined;
    if (!lineSplit(file)) return undefined;
    paths.add(file.path);
    files.push({ path: file.path, status: file.status as WorkspaceChangeFile["status"], lines: file.lines,
      ...(typeof file.oldPath === "string" ? { oldPath: file.oldPath } : {}),
      ...(typeof file.additions === "number" ? { additions: file.additions, deletions: file.deletions as number } : {}) });
  }
  if (value.fileCount < files.length || (!value.truncated && value.fileCount !== files.length) ||
    files.reduce((sum, file) => sum + file.lines, 0) > value.totalLines) return undefined;
  if (value.status !== "complete" && (files.length > 0 || value.fileCount !== 0 || value.totalLines !== 0 || value.truncated)) return undefined;
  return { version: 1, status: value.status as WorkspaceChangesMetadata["status"], files,
    fileCount: value.fileCount, totalLines: value.totalLines, truncated: value.truncated,
    ...(value.reason ? { reason: value.reason as WorkspaceChangesMetadata["reason"] } : {}),
    ...(typeof value.repositoryRoot === "string" ? { repositoryRoot: value.repositoryRoot } : {}) };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** 增删必须成对出现且与总行数一致；两者都缺失表示旧记录，仍可读。 */
function lineSplit(file: Record<string, unknown>): boolean {
  if (file.additions === undefined && file.deletions === undefined) return true;
  return count(file.additions) && count(file.deletions) && file.additions + file.deletions === file.lines;
}
function textPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= WORKSPACE_CHANGE_MAX_PATH_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}
function rootPath(value: unknown): value is string { return textPath(value) && /^(?:\/|[A-Za-z]:[\\/])/.test(value); }
function relativePath(value: unknown): value is string {
  return textPath(value) && !/^[\\/]|^[A-Za-z]:/.test(value) && !value.replace(/\\/g, "/").split("/").some((part) => part === ".." || part === "." || part === "");
}
