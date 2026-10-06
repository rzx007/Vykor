import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentChildResult, VykorAgent } from "@vykor/core";
import { readAutoReviewRunMetadata } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExecutionObservationService } from "../observability/execution-observation-service.js";
import { readSessionExecutionObservations } from "../observability/session-execution-observation-reader.js";
import { SessionEventPublisher } from "../session/session-event-publisher.js";
import {
  createGitRunChangeInspector,
  type GitRunBaseline,
  type GitRunChangeInspector,
  type GitRunChangeSet,
} from "./git-run-change-inspector.js";
import { AUTO_REVIEW_EVENT_TYPE, SessionAutoReviewService } from "./session-auto-review-service.js";
import { SessionWorkspaceChanges } from "../session/session-workspace-changes.js";

const MARKER = "AUTO_REVIEW_SECRET_MARKER";

function okOutput() {
  return JSON.stringify({ version: 1, verdict: "pass", summary: "ok", findings: [] });
}

describe("risk-based auto review integration", () => {
  let repo: string;
  let storeDir: string;
  let store: SessionStore;
  let sessionId: string;

  function git(args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  function write(relativePath: string, content: string): void {
    const fullPath = join(repo, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }

  function commit(message: string): void {
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
  }

  function clean(): void {
    git(["checkout", "--", "."]);
    git(["clean", "-fdq"]);
  }

  function createRun(): string {
    return store.runs.createRun({ sessionId }).id;
  }

  function service(inspector: GitRunChangeInspector = createGitRunChangeInspector()): SessionAutoReviewService {
    return new SessionAutoReviewService({
      session: store,
      events: new SessionEventPublisher(store.conversations, {
        broadcastSince: () => undefined,
        broadcastEvent: () => undefined,
      }),
      inspector,
    });
  }

  function fakeAgent(result: AgentChildResult): {
    agent: VykorAgent;
    calls: Array<{ sensitive: string; input: Record<string, unknown> }>;
  } {
    const calls: Array<{ sensitive: string; input: Record<string, unknown> }> = [];
    const agent = {
      runChildForCompletedRun: async (input: Record<string, unknown>, _parent: unknown, sensitive: string) => {
        calls.push({ sensitive, input });
        return { invocation: { id: "child-review-1", sessionId: "child-session", result: Promise.resolve(result) }, result };
      },
    } as unknown as VykorAgent;
    return { agent, calls };
  }

  async function reviewRunCountless(options: {
    mutate: () => void;
    result: AgentChildResult;
    inspector?: GitRunChangeInspector;
  }) {
    clean();
    const runId = createRun();
    const svc = service(options.inspector);
    await svc.captureBaseline({ sessionId, runId, cwd: repo, mode: "risk_based" });
    options.mutate();
    const harness = fakeAgent(options.result);
    const review = await svc.reviewCompletedRun({
      sessionId,
      inputId: `input-${runId}`,
      runId,
      traceId: "trace-1",
      cwd: repo,
      agent: harness.agent,
      signal: new AbortController().signal,
    });
    return { runId, review, harness };
  }

  function meta(runId: string) {
    return readAutoReviewRunMetadata(store.runs.getRun(runId)?.metadata.autoReview);
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "vykor-auto-review-int-"));
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "commit.gpgsign", "false"]);
    write("docs/a.md", "# base\n");
    write("packages/server/src/a.ts", "export const a = 1;\n");
    write("packages/auth/src/token.ts", "export const token = 1;\n");
    commit("base");

    storeDir = mkdtempSync(join(tmpdir(), "vykor-auto-review-store-"));
    store = new SessionStore({ path: join(storeDir, "sessions.db") });
    sessionId = store.sessions.create({ cwd: repo, model: "test-model" }).id;
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("records disabled for mode off without starting a child", async () => {
    const runId = createRun();
    const svc = service();
    const observation = new SessionWorkspaceChanges({ session: store,
      events: new SessionEventPublisher(store.conversations, { broadcastSince: () => undefined, broadcastEvent: () => undefined }),
      inspector: createGitRunChangeInspector() });
    const baseline = await observation.capture(runId, repo, repo);
    await svc.captureBaseline({ sessionId, runId, cwd: repo, mode: "off", observation: baseline });
    const changes = await observation.settle(runId);
    const harness = fakeAgent({ status: "completed", output: okOutput() });
    const review = await svc.reviewCompletedRun({
      sessionId, inputId: "input-off", runId, traceId: "trace-1", cwd: repo,
      agent: harness.agent, signal: new AbortController().signal,
      changes,
    });
    expect(review).toMatchObject({ status: "disabled", mode: "off", riskLevel: "none" });
    expect(harness.calls).toHaveLength(0);
    expect(meta(runId)).toMatchObject({ status: "disabled", mode: "off" });
    expect(store.runs.getRun(runId)?.metadata.workspaceChanges).toMatchObject({ status: "complete", fileCount: 0 });
  });

  it("skips a documentation-only change", async () => {
    const { review, harness } = await reviewRunCountless({
      mutate: () => write("docs/a.md", "# base\nmore docs\n"),
      result: { status: "completed", output: okOutput() },
    });
    expect(review).toMatchObject({ status: "skipped", riskLevel: "low" });
    expect(harness.calls).toHaveLength(0);
  });

  it("runs a read-only review for a medium source change and records pass", async () => {
    const { runId, review, harness } = await reviewRunCountless({
      mutate: () => write("packages/server/src/a.ts", `export const a = 2; // ${MARKER}\n`),
      result: { status: "completed", output: okOutput() },
    });
    expect(review).toMatchObject({ status: "passed", riskLevel: "medium", verdict: "pass" });
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.sensitive).toContain(MARKER);
    expect(harness.calls[0]!.input.allowedTools).toEqual([]);

    const observations = readSessionExecutionObservations({
      listSessions: () => store.sessions.list({ includeArchived: true }),
      listRuns: (id) => store.runs.listRuns(id),
      listRunAttempts: (id) => store.runs.listRunAttempts(id),
      listSessionTasks: (id) => store.runs.listSessionTasks(id),
    });
    const observationService = new ExecutionObservationService({
      readSessions: () => observations,
      readWorkflows: () => ({ records: [], warnings: [] }),
    });
    const report = observationService.query({ reviewStatuses: ["passed"] });
    expect(report.records.some((record) => record.runId === runId)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(MARKER);
    expect(JSON.stringify(report)).not.toMatch(/[A-Z]:\\/);

    expect(JSON.stringify(store.runs.getRun(runId)?.metadata)).not.toContain(MARKER);
    const events = store.conversations.listEvents({}).filter((event) => event.type === AUTO_REVIEW_EVENT_TYPE);
    expect(JSON.stringify(events)).not.toContain(MARKER);
    expect(meta(runId)?.status).toBe("passed");
  });

  it("records high-risk findings with counts", async () => {
    const output = JSON.stringify({
      version: 1,
      verdict: "fail",
      summary: "one problem",
      findings: [
        { severity: "critical", title: "Token leak", file: "packages/auth/src/token.ts", line: 1, evidence: "token exported" },
      ],
    });
    const { review } = await reviewRunCountless({
      mutate: () => write("packages/auth/src/token.ts", "export const token = 2;\n"),
      result: { status: "completed", output },
    });
    expect(review).toMatchObject({ status: "findings", riskLevel: "high", verdict: "fail", findingCount: 1, highestSeverity: "critical" });
  });

  it("never records passed for unparseable output or a failed reviewer", async () => {
    const invalid = await reviewRunCountless({
      mutate: () => write("packages/server/src/a.ts", "export const a = 3;\n"),
      result: { status: "completed", output: "not json" },
    });
    expect(invalid.review.status).toBe("failed");
    expect(invalid.review.reasons).toContain("review_output_invalid");

    const timedOut = await reviewRunCountless({
      mutate: () => write("packages/server/src/a.ts", "export const a = 4;\n"),
      result: { status: "failed", output: "", failureKind: "timeout" },
    });
    expect(timedOut.review).toMatchObject({ status: "timed_out" });
    expect(timedOut.review.status).not.toBe("passed");
  });

  it("refuses to review when a pre-existing dirty file changed again", async () => {
    clean();
    write("packages/server/src/a.ts", "export const a = 10;\n");
    const runId = createRun();
    const svc = service();
    await svc.captureBaseline({ sessionId, runId, cwd: repo, mode: "risk_based" });
    write("packages/server/src/a.ts", "export const a = 11;\n");
    const review = await svc.reviewCompletedRun({
      sessionId, inputId: "input-overlap", runId, traceId: "trace-1", cwd: repo,
      agent: fakeAgent({ status: "completed", output: okOutput() }).agent,
      signal: new AbortController().signal,
    });
    expect(review).toMatchObject({ status: "unavailable", reasons: ["preexisting_dirty_overlap"] });
  });

  it("converges a captured review on daemon restart", async () => {
    const runId = createRun();
    const svc = service();
    await svc.captureBaseline({ sessionId, runId, cwd: repo, mode: "risk_based" });
    expect(meta(runId)?.status).toBe("captured");
    expect(svc.failIncompleteReviewsOnStartup()).toBe(1);
    expect(meta(runId)).toMatchObject({ status: "unavailable", reasons: ["daemon_restarted"] });
    expect(svc.failIncompleteReviewsOnStartup()).toBe(0);
  });

  it("keeps processing 65 consecutive reviews", async () => {
    const baseline: GitRunBaseline = { repositoryRoot: repo, head: "h", dirty: {} };
    const changeSet: GitRunChangeSet = {
      files: [{ path: "packages/server/src/a.ts", status: "modified", lines: 5 }],
      attribution: "complete",
      patch: "diff --git a/packages/server/src/a.ts b/packages/server/src/a.ts\n",
      patchTruncated: false,
      baseHead: "h",
      head: "h",
    };
    const inspector: GitRunChangeInspector = {
      capture: async () => baseline,
      compare: async () => changeSet,
    };
    for (let index = 0; index < 65; index += 1) {
      const { review } = await reviewRunCountless({
        mutate: () => undefined,
        result: { status: "completed", output: okOutput() },
        inspector,
      });
      expect(review.status).toBe("passed");
    }
  }, 60_000);
});
