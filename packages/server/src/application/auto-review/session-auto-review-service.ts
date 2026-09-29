import type {
  AppendEventInput,
  SessionEventRecord,
  SessionRunRecord,
  UpdateRunInput,
} from "@vykor/protocol";
import {
  readAutoReviewRunMetadata,
  type AutoReviewMode,
  type AutoReviewReason,
  type AutoReviewRunMetadata,
  type AutoReviewSeverity,
  type AutoReviewStatus,
} from "@vykor/protocol";
import { getBuiltinAgentDefinitions } from "@vykor/coordinator";
import type { RunCapabilityView } from "@vykor/core";
import type { VykorAgent } from "@vykor/agent-runtime";

import { classifyAutoReviewRisk, type AutoReviewChangeSet } from "./auto-review-policy.js";
import { buildAutoReviewPrompt, parseAutoReviewResult } from "./auto-review-result.js";
import type {
  GitRunBaseline,
  GitRunChangeInspector,
  GitRunChangeSet,
} from "./git-run-change-inspector.js";

export const AUTO_REVIEW_EVENT_TYPE = "session.auto_review.updated";

export interface AutoReviewSessionPort {
  transaction<T>(work: () => T): T;
  runs: {
    getRun(runId: string): SessionRunRecord | undefined;
    updateRun(runId: string, input: UpdateRunInput): SessionRunRecord;
    listAllRuns(): SessionRunRecord[];
  };
  conversations: {
    appendEvent(input: AppendEventInput): SessionEventRecord;
  };
}

export interface AutoReviewEventPublisherPort {
  checkpoint(): number;
  publishSince(seq: number): void;
}

export interface SessionAutoReviewServiceOptions {
  store: AutoReviewSessionPort;
  events: AutoReviewEventPublisherPort;
  inspector: GitRunChangeInspector;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface CaptureBaselineInput {
  sessionId: string;
  runId: string;
  cwd: string;
  mode: AutoReviewMode;
}

export interface ReviewCompletedRunInput {
  sessionId: string;
  inputId: string;
  runId: string;
  traceId: string;
  cwd: string;
  agent: VykorAgent;
  signal: AbortSignal;
}

interface BaselineEntry {
  baseline: GitRunBaseline;
  mode: AutoReviewMode;
}

type ReviewBase = Omit<AutoReviewRunMetadata, "version" | "policyVersion">;

const SEVERITY_RANK: Record<AutoReviewSeverity, number> = {
  minor: 0,
  important: 1,
  critical: 2,
};

/**
 * 持久化的按风险自动评审状态机。
 *
 * 只写入有界的父 Run metadata 与 `session.auto_review.updated` 事件：patch、prompt、
 * findings 正文和绝对路径永不进入父级持久状态。任一失败分支都记录真实状态，
 * 绝不把异常降级为 passed。
 */
export class SessionAutoReviewService {
  private readonly baselines = new Map<string, BaselineEntry>();
  private readonly now: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(private readonly options: SessionAutoReviewServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
  }

  async captureBaseline(input: CaptureBaselineInput): Promise<void> {
    if (input.mode === "off") {
      this.transition(input.sessionId, input.runId, {
        mode: "off",
        riskLevel: "none",
        status: "disabled",
        reasons: ["mode_off"],
      });
      return;
    }
    try {
      const captured = await this.options.inspector.capture(input.cwd);
      if (isUnavailable(captured)) {
        this.transition(input.sessionId, input.runId, {
          mode: input.mode,
          riskLevel: "unknown",
          status: "unavailable",
          reasons: [captured.reason],
        });
        return;
      }
      this.baselines.set(input.runId, { baseline: captured, mode: input.mode });
      this.transition(input.sessionId, input.runId, {
        mode: input.mode,
        riskLevel: "unknown",
        status: "captured",
        reasons: [],
      });
    } catch (error) {
      this.recordFailure(input.sessionId, input.runId, input.mode, error);
    }
  }

  async reviewCompletedRun(input: ReviewCompletedRunInput): Promise<AutoReviewRunMetadata> {
    const entry = this.baselines.get(input.runId);
    this.baselines.delete(input.runId);
    const existing = this.readReview(input.runId);
    // Disabled runs never captured a baseline; preserve their real state instead of
    // overwriting it with an unattributable failure.
    if (existing && (existing.mode === "off" || existing.status === "disabled")) {
      return existing;
    }
    const startedAt = this.now();
    if (!entry) {
      if (existing && existing.status !== "captured") return existing;
      return this.settle(input.sessionId, input.runId, {
        mode: existing?.mode ?? "risk_based",
        riskLevel: "unknown",
        status: "unavailable",
        reasons: ["git_inspection_failed"],
        startedAt,
        finishedAt: this.now(),
      });
    }

    try {
      const compared = await this.options.inspector.compare(input.cwd, entry.baseline);
      if (isUnavailable(compared)) {
        return this.settle(input.sessionId, input.runId, {
          mode: entry.mode,
          riskLevel: "unknown",
          status: "unavailable",
          reasons: [compared.reason],
          startedAt,
          finishedAt: this.now(),
        });
      }
      return await this.runReview(input, entry.mode, compared, startedAt);
    } catch (error) {
      this.log({ event: "auto_review.error", runId: input.runId, error: errorText(error) });
      return this.settle(input.sessionId, input.runId, {
        mode: entry.mode,
        riskLevel: "unknown",
        status: "failed",
        reasons: ["git_inspection_failed"],
        startedAt,
        finishedAt: this.now(),
      });
    }
  }

  private async runReview(
    input: ReviewCompletedRunInput,
    mode: AutoReviewMode,
    changeSet: GitRunChangeSet,
    startedAt: number,
  ): Promise<AutoReviewRunMetadata> {
    const decision = classifyAutoReviewRisk(changeSet);
    if (!decision.shouldReview) {
      return this.settle(input.sessionId, input.runId, {
        mode,
        riskLevel: decision.level,
        status: "skipped",
        reasons: decision.reasons,
        patchTruncated: changeSet.patchTruncated,
        startedAt,
        finishedAt: this.now(),
      });
    }

    const role = getBuiltinAgentDefinitions().find((agent) => agent.name === "review");
    if (!role || role.source !== "builtin") {
      return this.settle(input.sessionId, input.runId, {
        mode,
        riskLevel: decision.level,
        status: "failed",
        reasons: ["review_child_failed"],
        patchTruncated: changeSet.patchTruncated,
        startedAt,
        finishedAt: this.now(),
      });
    }

    this.transition(input.sessionId, input.runId, {
      mode,
      riskLevel: decision.level,
      status: "pending",
      reasons: decision.reasons,
      patchTruncated: changeSet.patchTruncated,
      startedAt,
    });

    const built = buildAutoReviewPrompt({
      risk: decision,
      files: changeSet.files,
      patch: changeSet.patch,
      patchTruncated: changeSet.patchTruncated,
    });
    const sensitiveInitialContent = [
      built.prompt,
      built.scope,
      built.expectedResult,
      "",
      "Untrusted patch to review:",
      changeSet.patch,
    ].join("\n");

    let invocationId: string | undefined;
    let childResult: { status: string; output: string; failureKind?: string };
    try {
      const outcome = await input.agent.runChildForCompletedRun(
        {
          description: "Automatic risk-based review",
          // Only a bounded summary is published in child.created / the parent Task;
          // full instructions and the untrusted patch travel via sensitive initial content.
          prompt: "Automatic read-only review of this run's changes",
          agent: "review",
          cwd: input.cwd,
          ...(role.systemPrompt ? { systemPrompt: role.systemPrompt } : {}),
          allowedTools: [],
          requiredMcpServers: [],
          ...(decision.requestedMaxTurns !== undefined
            ? { requestedMaxTurns: decision.requestedMaxTurns }
            : {}),
          ...(decision.requestedTimeoutSeconds !== undefined
            ? { requestedTimeoutSeconds: decision.requestedTimeoutSeconds }
            : {}),
          scope: built.scope,
          expectedResult: built.expectedResult,
        },
        { inputId: input.inputId, runId: input.runId, traceId: input.traceId, signal: input.signal },
        sensitiveInitialContent,
        emptyCapabilityView(),
      );
      invocationId = outcome.invocation.id;
      childResult = outcome.result;
    } catch (error) {
      this.log({ event: "auto_review.child_error", runId: input.runId, error: errorText(error) });
      return this.settle(input.sessionId, input.runId, {
        mode,
        riskLevel: decision.level,
        status: "failed",
        reasons: ["review_child_failed"],
        patchTruncated: changeSet.patchTruncated,
        ...(invocationId ? { reviewTaskId: invocationId } : {}),
        startedAt,
        finishedAt: this.now(),
      });
    }

    const finishedAt = this.now();
    if (childResult.status !== "completed") {
      const timedOut = childResult.failureKind === "timeout";
      return this.settle(input.sessionId, input.runId, {
        mode,
        riskLevel: decision.level,
        status: timedOut ? "timed_out" : "failed",
        reasons: [timedOut ? "review_child_timed_out" : "review_child_failed"],
        patchTruncated: changeSet.patchTruncated,
        ...(invocationId !== undefined ? { reviewTaskId: invocationId } : {}),
        startedAt,
        finishedAt,
      });
    }

    const allowedPaths = new Set(changeSet.files.map((file) => file.path));
    const parsed = parseAutoReviewResult(childResult.output, allowedPaths);
    if (!parsed) {
      return this.settle(input.sessionId, input.runId, {
        mode,
        riskLevel: decision.level,
        status: "failed",
        reasons: ["review_output_invalid"],
        patchTruncated: changeSet.patchTruncated,
        ...(invocationId !== undefined ? { reviewTaskId: invocationId } : {}),
        startedAt,
        finishedAt,
      });
    }

    const verdict = changeSet.patchTruncated && parsed.verdict === "pass" ? "partial" : parsed.verdict;
    const status: AutoReviewStatus =
      verdict === "pass" ? "passed" : verdict === "fail" ? "findings" : "partial";
    const severity = highestSeverity(parsed.findings.map((finding) => finding.severity));
    return this.settle(input.sessionId, input.runId, {
      mode,
      riskLevel: decision.level,
      status,
      reasons: decision.reasons,
      verdict,
      findingCount: parsed.findings.length,
      ...(severity ? { highestSeverity: severity } : {}),
      patchTruncated: changeSet.patchTruncated,
      ...(invocationId !== undefined ? { reviewTaskId: invocationId } : {}),
      startedAt,
      finishedAt,
    });
  }

  settleUnreviewedRun(input: {
    sessionId: string;
    runId: string;
    reason: "parent_run_not_completed";
  }): AutoReviewRunMetadata | undefined {
    const existing = this.readReview(input.runId);
    this.baselines.delete(input.runId);
    // Only a captured baseline can be converged. Disabled runs and capture-time
    // unavailability keep their real state and precise reason.
    if (!existing || existing.status !== "captured") return existing;
    return this.settle(input.sessionId, input.runId, {
      ...existing,
      status: "unavailable",
      reasons: [input.reason],
      finishedAt: this.now(),
    });
  }

  /** Converge unfinished reviews left behind by a daemon restart. Idempotent. */
  failIncompleteReviewsOnStartup(): number {
    let count = 0;
    for (const run of this.options.store.runs.listAllRuns()) {
      const review = readAutoReviewRunMetadata(run.metadata?.autoReview);
      if (!review) continue;
      if (review.status === "pending") {
        this.settle(run.sessionId, run.id, {
          ...review,
          status: "failed",
          reasons: ["daemon_restarted"],
          finishedAt: this.now(),
        });
        count += 1;
      } else if (review.status === "captured") {
        this.settle(run.sessionId, run.id, {
          ...review,
          status: "unavailable",
          reasons: ["daemon_restarted"],
          finishedAt: this.now(),
        });
        count += 1;
      }
    }
    return count;
  }

  private readReview(runId: string): AutoReviewRunMetadata | undefined {
    return readAutoReviewRunMetadata(this.options.store.runs.getRun(runId)?.metadata?.autoReview);
  }

  private settle(
    sessionId: string,
    runId: string,
    review: ReviewBase,
  ): AutoReviewRunMetadata {
    return this.transition(sessionId, runId, review);
  }

  private transition(
    sessionId: string,
    runId: string,
    review: ReviewBase,
  ): AutoReviewRunMetadata {
    const validated = readAutoReviewRunMetadata({ ...review, version: 1, policyVersion: "risk-v1" });
    if (!validated) throw new Error(`Invalid auto review metadata for run ${runId}`);
    const seq = this.options.events.checkpoint();
    this.options.store.transaction(() => {
      this.options.store.runs.updateRun(runId, { metadata: { autoReview: validated } });
      this.options.store.conversations.appendEvent({
        type: AUTO_REVIEW_EVENT_TYPE,
        sessionId,
        payload: { runId, review: validated },
      });
    });
    this.options.events.publishSince(seq);
    return validated;
  }

  private recordFailure(sessionId: string, runId: string, mode: AutoReviewMode, error: unknown): void {
    this.log({ event: "auto_review.error", runId, error: errorText(error) });
    try {
      this.transition(sessionId, runId, {
        mode,
        riskLevel: "unknown",
        status: "failed",
        reasons: ["git_inspection_failed"],
        finishedAt: this.now(),
      });
    } catch (transitionError) {
      this.log({ event: "auto_review.transition_error", runId, error: errorText(transitionError) });
    }
  }
}

function isUnavailable(
  value: GitRunBaseline | AutoReviewChangeSet | { attribution: "unavailable"; reason: AutoReviewReason },
): value is { attribution: "unavailable"; reason: AutoReviewReason } {
  return (value as { attribution?: string }).attribution === "unavailable";
}

function highestSeverity(severities: AutoReviewSeverity[]): AutoReviewSeverity | undefined {
  let best: AutoReviewSeverity | undefined;
  let bestRank = -1;
  for (const severity of severities) {
    const rank = SEVERITY_RANK[severity];
    if (rank > bestRank) {
      best = severity;
      bestRank = rank;
    }
  }
  return best;
}

function emptyCapabilityView(): RunCapabilityView {
  const inner = new Map<string, never>();
  return Object.freeze({
    tools: emptyReadonlyMap(inner),
    skills: emptyReadonlyMap(inner),
    agents: emptyReadonlyMap(inner),
    mcpServers: emptyReadonlyMap(inner),
  });
}

function emptyReadonlyMap<T>(inner: Map<string, T>): ReadonlyMap<string, T> {
  return Object.freeze({
    size: 0,
    get: () => undefined,
    has: () => false,
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    forEach: () => undefined,
  }) as ReadonlyMap<string, T>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
