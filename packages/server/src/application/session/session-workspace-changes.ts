import { resolve } from "node:path";
import {
  readWorkspaceChangesMetadata, WORKSPACE_CHANGE_MAX_FILES, WORKSPACE_CHANGE_MAX_PATH_LENGTH, WORKSPACE_CHANGE_REASONS,
  type WorkspaceChangesMetadata,
} from "@vykor/protocol";
import type { GitRunBaseline, GitRunChangeInspector, GitRunChangeSet, GitRunChangeUnavailable } from "../auto-review/git-run-change-inspector.js";
import type { AutoReviewSessionPort, AutoReviewEventPublisherPort } from "../auto-review/session-auto-review-service.js";

export type WorkspaceChangeResult = GitRunChangeSet | GitRunChangeUnavailable;
export type WorkspaceBaselineResult = GitRunBaseline | GitRunChangeUnavailable;
interface ActiveObservation { cwd: string; baseline?: GitRunBaseline; overlap: boolean; }

// Before-model work is capped separately from after-model settlement. Slow/large
// repositories explicitly return unavailable instead of holding the session lane.
export const WORKSPACE_CAPTURE_BUDGET_MS = 2_000;
export const WORKSPACE_SETTLE_BUDGET_MS = 5_000;

/** Owns the Git capture/compare interval independently of optional model review. */
export class SessionWorkspaceChanges {
  private readonly active = new Map<string, ActiveObservation>();
  constructor(private readonly options: {
    session: AutoReviewSessionPort;
    events: AutoReviewEventPublisherPort;
    inspector: GitRunChangeInspector;
    log?: (entry: Record<string, unknown>) => void;
    captureBudgetMs?: number;
    settleBudgetMs?: number;
  }) {}

  async capture(runId: string, cwd: string, localExecutionCwd?: string, signal?: AbortSignal): Promise<WorkspaceBaselineResult> {
    const entry: ActiveObservation = { cwd, overlap: false };
    this.active.set(runId, entry);
    this.markOverlaps(runId, entry);
    try {
      if (!localExecutionCwd || normalize(resolve(localExecutionCwd)) !== normalize(resolve(cwd))) {
        return this.unavailable(runId, "execution_environment_unavailable");
      }
      const baseline = await this.inspect(signal, this.options.captureBudgetMs ?? WORKSPACE_CAPTURE_BUDGET_MS,
        (inspectionSignal) => this.options.inspector.capture(cwd, inspectionSignal));
      if ("attribution" in baseline) {
        this.writeUnavailable(runId, baseline.reason);
        return baseline;
      }
      entry.baseline = baseline;
      this.markOverlaps(runId, entry);
      if (!this.write(runId, { version: 1, status: "captured", repositoryRoot: baseline.repositoryRoot,
        files: [], fileCount: 0, totalLines: 0, truncated: false })) return this.unavailable(runId, "git_inspection_failed");
      return baseline;
    } catch (error) {
      this.log(runId, error);
      return this.unavailable(runId, signal?.aborted ? "observation_cancelled" : error === "observation_budget_exceeded" ? "observation_budget_exceeded" : "git_inspection_failed");
    }
  }

  async settle(runId: string, signal?: AbortSignal): Promise<WorkspaceChangeResult> {
    const entry = this.active.get(runId);
    try {
      if (!entry?.baseline) {
        const stored = readWorkspaceChangesMetadata(this.options.session.runs.getRun(runId)?.metadata.workspaceChanges);
        return { attribution: "unavailable", reason: (stored?.reason ?? "git_inspection_failed") as GitRunChangeUnavailable["reason"] };
      }
      if (entry.overlap) return this.unavailable(runId, "concurrent_run_overlap");
      const result = await this.inspect(signal, this.options.settleBudgetMs ?? WORKSPACE_SETTLE_BUDGET_MS,
        (inspectionSignal) => this.options.inspector.compare(entry.cwd, entry.baseline!, inspectionSignal));
      if (entry.overlap) return this.unavailable(runId, "concurrent_run_overlap");
      if (result.attribution === "unavailable") { this.writeUnavailable(runId, result.reason); return result; }
      if (result.attribution === "incomplete") return this.unavailable(runId, result.attributionReason ?? "git_inspection_failed");
      const files = result.files.filter((file) => file.path.length <= WORKSPACE_CHANGE_MAX_PATH_LENGTH &&
        (file.oldPath?.length ?? 0) <= WORKSPACE_CHANGE_MAX_PATH_LENGTH).slice(0, WORKSPACE_CHANGE_MAX_FILES);
      if (!this.write(runId, { version: 1, status: "complete", repositoryRoot: entry.baseline.repositoryRoot,
        files, fileCount: result.files.length, totalLines: result.files.reduce((sum, file) => sum + file.lines, 0),
        truncated: files.length !== result.files.length || result.patchTruncated })) return this.unavailable(runId, "git_inspection_failed");
      return result;
    } catch (error) {
      this.log(runId, error);
      return this.unavailable(runId, signal?.aborted ? "observation_cancelled" : error === "observation_budget_exceeded" ? "observation_budget_exceeded" : "git_inspection_failed");
    } finally { this.active.delete(runId); }
  }

  failIncompleteOnStartup(): void {
    for (const run of this.options.session.runs.listAllRuns()) {
      if (readWorkspaceChangesMetadata(run.metadata.workspaceChanges)?.status === "captured") this.writeUnavailable(run.id, "daemon_restarted");
    }
  }

  private async inspect<T>(parent: AbortSignal | undefined, budgetMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new AbortController();
    const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort("observation_budget_exceeded"), budgetMs);
    try {
      signal.throwIfAborted();
      const result = await work(signal);
      signal.throwIfAborted();
      return result;
    } finally { clearTimeout(timer); }
  }

  private markOverlaps(runId: string, entry: ActiveObservation): void {
    const root = entry.baseline?.repositoryRoot ?? entry.cwd;
    for (const [otherId, other] of this.active) {
      if (otherId !== runId && (within(other.cwd, root) || within(entry.cwd, other.baseline?.repositoryRoot ?? other.cwd))) {
        // Keep this flag even after the other Run leaves the active map.
        other.overlap = true;
        entry.overlap = true;
      }
    }
  }

  private unavailable(runId: string, reason: string | undefined): GitRunChangeUnavailable {
    const safeReason = WORKSPACE_CHANGE_REASONS.find((allowed) => allowed === reason) ?? "git_inspection_failed";
    this.writeUnavailable(runId, safeReason);
    return { attribution: "unavailable", reason: safeReason };
  }
  private writeUnavailable(runId: string, reason: string | undefined): void {
    this.write(runId, { version: 1, status: "unavailable", reason: WORKSPACE_CHANGE_REASONS.find((allowed) => allowed === reason) ?? "git_inspection_failed",
      files: [], fileCount: 0, totalLines: 0, truncated: false });
  }
  private write(runId: string, metadata: WorkspaceChangesMetadata): boolean {
    try {
      const validated = readWorkspaceChangesMetadata(metadata);
      if (!validated) throw new Error("Invalid workspace changes metadata");
      const seq = this.options.events.checkpoint();
      this.options.session.transaction(() => this.options.session.runs.updateRun(runId, { metadata: { workspaceChanges: validated } }));
      this.options.events.publishSince(seq);
      return true;
    } catch (error) { this.log(runId, error); return false; }
  }
  private log(runId: string, error: unknown): void {
    this.options.log?.({ event: "workspace_changes.failed", runId, error: error instanceof Error ? error.message : String(error) });
  }
}
function normalize(path: string): string { const normalized = path.replace(/\\/g, "/").replace(/\/$/, ""); return process.platform === "win32" ? normalized.toLowerCase() : normalized; }
function within(path: string, root: string): boolean { return normalize(path) === normalize(root) || normalize(path).startsWith(`${normalize(root)}/`); }
