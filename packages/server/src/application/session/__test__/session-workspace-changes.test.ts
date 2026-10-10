import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@vykor/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vykor/agent-runtime")>();
  return { ...actual, createDefaultNodeAgent: vi.fn() };
});
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { createDaemonAgentLoader, readDaemonAgentLocalWorkspace } from "../../../daemon/daemon-agent.js";
import { SessionStore } from "@vykor/services";
import { readWorkspaceChangesMetadata } from "@vykor/protocol";
import { fileWriteTool } from "../../../../../tools/src/file/write.js";
import { createExecFileGitExecutor, createGitRunChangeInspector } from "../../auto-review/git-run-change-inspector.js";
import { SessionEventPublisher } from "../session-event-publisher.js";
import { SessionWorkspaceChanges } from "../session-workspace-changes.js";
import { SessionAutoReviewService } from "../../auto-review/session-auto-review-service.js";
import { SessionRunExecutor } from "../session-run-executor.js";

describe("read-only Run workspace observation", () => {
  let repo: string, storeDir: string, store: SessionStore, sessionId: string;
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  const events = () => new SessionEventPublisher(store.conversations, { broadcastSince: () => {}, broadcastEvent: () => {} });
  const observer = (inspector = createGitRunChangeInspector()) => new SessionWorkspaceChanges({ session: store, events: events(), inspector });
  const metadata = (id: string) => readWorkspaceChangesMetadata(store.runs.getRun(id)?.metadata.workspaceChanges);
  const createRun = () => store.runs.createRun({ sessionId }).id;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "vykor-workspace-"));
    storeDir = mkdtempSync(join(tmpdir(), "vykor-workspace-store-"));
    git(["init", "-q"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.com"]);
    git(["config", "commit.gpgsign", "false"]); git(["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "base.txt"), "base\n"); git(["add", "."]); git(["commit", "-qm", "base"]);
    store = new SessionStore({ path: join(storeDir, "sessions.db") });
    sessionId = store.sessions.create({ cwd: repo, model: "offline" }).id;
  });
  afterEach(() => { store.close(); rmSync(repo, { recursive: true, force: true }); rmSync(storeDir, { recursive: true, force: true }); });

  it.each([false, true])("observes real Write and safe Shell effects through the off-mode executor (review service wired=%s)", async (reviewWired) => {
    const runId = createRun();
    const input = store.conversationTransactions.admitPrompt({ sessionId, delivery: "queue", items: [{ type: "text", text: "offline" }] });
    const inspector = createGitRunChangeInspector();
    const changes = observer(inspector);
    let childCalls = 0;
    const agent = {
      submitMessage: () => ({ result: (async () => {
        store.runs.updateRun(runId, { status: "running" });
        const result = await fileWriteTool.execute({ file_path: join(repo, "written.txt"), content: "written\n" }, { cwd: repo } as any);
        expect(result.isError).not.toBe(true);
        execFileSync(process.execPath, ["-e", "require('fs').writeFileSync('shell.txt', 'shell\\n')"], { cwd: repo });
        store.runs.updateRun(runId, { status: "completed" });
        return { status: "completed", output: "offline" };
      })() }),
      runChildForCompletedRun: async () => { childCalls++; throw new Error("off mode must not call a reviewer"); },
    } as any;
    const executor = new SessionRunExecutor({ data: store, attachments: store.attachments, goals: store.goals,
      agentPool: { configured: true, acquireSession: async () => agent, close: async () => {}, closeIfStale: async () => {} },
      transcriptProjection: { finalizeRunParts: () => {}, projectAttachmentTransformations: () => {} },
      events: events(), traceIdForRun: () => "offline", log: () => {}, workspaceChanges: changes,
      resolveLocalExecutionCwd: () => repo, resolveAutoReviewMode: async () => "off",
      ...(reviewWired ? { autoReview: new SessionAutoReviewService({ session: store, events: events(), inspector }) } : {}),
    } as any);
    await executor.execute({ sessionId, runId, inputId: input.id }, { signal: new AbortController().signal, registerHandle: async () => {} });
    expect(metadata(runId)).toMatchObject({ status: "complete", fileCount: 2, totalLines: 2, files: [
      { path: "shell.txt", status: "added", lines: 1, additions: 1, deletions: 0 },
      { path: "written.txt", status: "added", lines: 1, additions: 1, deletions: 0 },
    ] });
    expect(childCalls).toBe(0);
    if (reviewWired) expect(store.runs.getRun(runId)?.metadata.autoReview).toMatchObject({ status: "disabled", mode: "off" });
    expect(store.conversations.listEvents({}).at(-1)?.payload).not.toHaveProperty("patch");
  });

  it("records real tracked line changes without patch or body persistence and keeps terminal timing/index intact", async () => {
    const id = createRun(); const svc = observer();
    const indexBefore = readFileSync(join(repo, ".git/index"));
    await svc.capture(id, repo, repo);
    writeFileSync(join(repo, "base.txt"), "new-secret-body\nmore\n");
    store.runs.updateRun(id, { status: "completed" });
    const finishedAt = store.runs.getRun(id)?.finishedAt;
    await svc.settle(id);
    expect(metadata(id)).toMatchObject({ status: "complete", fileCount: 1, totalLines: 3, files: [
      { path: "base.txt", status: "modified", lines: 3, additions: 2, deletions: 1 },
    ] });
    expect(JSON.stringify(store.runs.getRun(id)?.metadata)).not.toContain("new-secret-body");
    expect(store.runs.getRun(id)?.finishedAt).toBe(finishedAt);
    expect(store.runs.getRun(id)?.status).toBe("completed");
    expect(readFileSync(join(repo, ".git/index"))).toEqual(indexBefore);
  });

  it("refuses preexisting dirty overlap instead of reporting an empty success", async () => {
    writeFileSync(join(repo, "base.txt"), "dirty\n");
    const id = createRun(); const svc = observer(); await svc.capture(id, repo, repo);
    writeFileSync(join(repo, "base.txt"), "dirty again\n"); await svc.settle(id);
    expect(metadata(id)).toMatchObject({ status: "unavailable", reason: "preexisting_dirty_overlap" });
  });

  it("captures dirty files relative to the repository root when the Run cwd is a subdirectory", async () => {
    const subdir = join(repo, "nested"); mkdirSync(subdir);
    writeFileSync(join(repo, "base.txt"), "preexisting\n");
    expect(git(["-C", subdir, "ls-files", "-s", "-z"]).length).toBe(0);
    expect(git(["ls-files", "-s", "-z"]).length).toBeGreaterThan(0);
    const id = createRun(); const svc = observer();
    expect(await svc.capture(id, subdir, subdir)).toHaveProperty("repositoryRoot");
    writeFileSync(join(repo, "base.txt"), "changed during nested run\n"); await svc.settle(id);
    expect(metadata(id)).toMatchObject({ status: "unavailable", reason: "preexisting_dirty_overlap" });
  });

  it("remembers a second root Run that starts and finishes inside the observation interval", async () => {
    const svc = observer(); const outer = createRun(); await svc.capture(outer, repo, repo);
    const nestedSession = store.sessions.create({ cwd: repo, model: "offline" }).id;
    const nested = store.runs.createRun({ sessionId: nestedSession }).id;
    await svc.capture(nested, repo, repo); writeFileSync(join(repo, "other.txt"), "other\n");
    store.runs.updateRun(nested, { status: "completed" }); await svc.settle(nested); await svc.settle(outer);
    expect(metadata(outer)).toMatchObject({ status: "unavailable", reason: "concurrent_run_overlap" });
    expect(metadata(nested)).toMatchObject({ status: "unavailable", reason: "concurrent_run_overlap" });
  });

  it("marks a known same-repository overlap before the other baseline finishes capturing", async () => {
    const real = createGitRunChangeInspector(); let calls = 0;
    let entered!: () => void, release!: () => void;
    const enteredCapture = new Promise<void>((resolve) => { entered = resolve; });
    const releaseCapture = new Promise<void>((resolve) => { release = resolve; });
    const svc = observer({ capture: async (cwd) => {
      if (++calls === 2) { entered(); await releaseCapture; }
      return real.capture(cwd);
    }, compare: (cwd, base) => real.compare(cwd, base) });
    const outer = createRun(); await svc.capture(outer, repo, repo);
    const nested = createRun(); const pending = svc.capture(nested, repo, repo);
    await enteredCapture; await svc.settle(outer);
    release(); await pending; await svc.settle(nested);
    expect(metadata(outer)).toMatchObject({ status: "unavailable", reason: "concurrent_run_overlap" });
  });

  it("rejects non-Git and unknown/WSL execution workspaces", async () => {
    const svc = observer(); const noGit = createRun(); await svc.capture(noGit, storeDir, storeDir); await svc.settle(noGit);
    expect(metadata(noGit)).toMatchObject({ status: "unavailable", reason: "not_git_repository" });
    const wsl = createRun(); await svc.capture(wsl, repo, "/mnt/d/repo"); await svc.settle(wsl);
    expect(metadata(wsl)).toMatchObject({ status: "unavailable", reason: "execution_environment_unavailable" });
  });

  it.each([
    { policy: "denyRead", mode: "off" as const, nested: false, sandbox: { enabled: true, filesystem: { allowRead: ["."], denyRead: ["private"] } } },
    { policy: "denyRead", mode: "risk_based" as const, nested: false, sandbox: { enabled: true, filesystem: { allowRead: ["."], denyRead: ["private"] } } },
    { policy: "nested allowRead", mode: "off" as const, nested: true, sandbox: { enabled: true, filesystem: { allowRead: ["."] } } },
    { policy: "unknown", mode: "off" as const, nested: false, sandbox: undefined },
  ])("never calls host Git for the actual warm Agent's $policy read policy ($mode)", async ({ mode, nested, sandbox }) => {
    mkdirSync(join(repo, "private")); writeFileSync(join(repo, "private/data.txt"), "base secret\n");
    git(["add", "."]); git(["commit", "-qm", "private fixture"]);
    writeFileSync(join(repo, "private/data.txt"), "preexisting dirty secret\n");
    const cwd = nested ? join(repo, "nested") : repo; if (nested) mkdirSync(cwd);
    const agent = { loadHistory: () => {}, close: async () => {} } as any;
    vi.mocked(createDefaultNodeAgent).mockResolvedValueOnce(agent);
    const actualSettings = { model: "offline", agentEnvironment: { kind: "native" }, ...(sandbox ? { sandbox } : {}) } as any;
    await createDaemonAgentLoader({ settings: actualSettings })!({ session: { ...store.sessions.get(sessionId)!, cwd, metadata: { runtime: { model: "offline" } } }, history: [], parts: [] });
    // Changing settings later must not manufacture unrestricted warm-Agent evidence.
    actualSettings.sandbox = { enabled: false };
    const calls: string[][] = []; const gitExecutor = createExecFileGitExecutor();
    const inspector = createGitRunChangeInspector({ exec: async (args, path) => { calls.push(args); return gitExecutor.exec(args, path); } });
    const id = createRun(); const svc = observer(inspector);
    const baseline = await svc.capture(id, cwd, readDaemonAgentLocalWorkspace(agent));
    const review = new SessionAutoReviewService({ session: store, events: events(), inspector });
    await review.captureBaseline({ sessionId, runId: id, cwd, mode, observation: baseline });
    writeFileSync(join(repo, "new.txt"), "after Run\n"); const changes = await svc.settle(id);
    await review.reviewCompletedRun({ sessionId, inputId: "offline", runId: id, traceId: "offline", cwd,
      changes, signal: new AbortController().signal, agent: { runChildForCompletedRun: async () => { throw new Error("must not review restricted reads"); } } as any });
    expect(calls).toEqual([]);
    expect(metadata(id)).toMatchObject({ status: "unavailable", reason: "execution_environment_unavailable" });
  });

  it("isolates inspection errors and conserves disabled review state", async () => {
    const id = createRun(); const svc = observer({ capture: async () => { throw new Error("git unavailable"); }, compare: async () => { throw new Error("unused"); } });
    store.runs.updateRun(id, { status: "completed" }); await svc.capture(id, repo, repo); await svc.settle(id);
    expect(metadata(id)).toMatchObject({ status: "unavailable", reason: "git_inspection_failed" });
    expect(store.runs.getRun(id)?.status).toBe("completed");
  });

  it("never requests a sensitive patch", async () => {
    const real = createGitRunChangeInspector();
    const id = createRun(); const svc = observer(real); await svc.capture(id, repo, repo);
    writeFileSync(join(repo, ".env"), "SECRET=value\n"); await svc.settle(id);
    expect(metadata(id)).toMatchObject({ status: "unavailable", reason: "sensitive_content_path" });
    expect(JSON.stringify(store.conversations.listEvents({}))).not.toContain("SECRET=value");
  });

  it.each(["diff.external", "diff.probe.textconv", "filter.probe.clean", "core.fsmonitor"])("does not execute repository configured %s programs", async (config) => {
    writeFileSync(join(repo, ".gitattributes"), "*.txt diff=probe filter=probe\n");
    writeFileSync(join(repo, "marker.cjs"), "require('fs').writeFileSync('driver-ran.txt', 'called'); process.stdout.write('safe output');\n");
    git(["add", "."]); git(["commit", "-qm", "driver fixture"]);
    git(["config", config, `"${process.execPath.replace(/\\/g, "/")}" marker.cjs`]);
    writeFileSync(join(repo, "base.txt"), "preexisting dirty\n");
    const id = createRun(); const svc = observer(); await svc.capture(id, repo, repo);
    writeFileSync(join(repo, "new.txt"), "during Run\n"); await svc.settle(id);
    expect(existsSync(join(repo, "driver-ran.txt"))).toBe(false);
  });

  it("bounds summary files, marks truncation, and recovers a lost baseline", async () => {
    const real = createGitRunChangeInspector();
    const svc = observer({ capture: (cwd) => real.capture(cwd), compare: async () => ({
      attribution: "complete", baseHead: "fixture", head: "fixture", patch: "not persisted", patchTruncated: false,
      files: Array.from({ length: 130 }, (_, n) => ({ path: `many/${n}.txt`, status: "added" as const, lines: 1 })),
    }) });
    const id = createRun(); await svc.capture(id, repo, repo);
    await svc.settle(id);
    expect(metadata(id)).toMatchObject({ status: "complete", fileCount: 130, totalLines: 130, truncated: true });
    expect(metadata(id)?.files).toHaveLength(128);
    const pending = createRun(); await svc.capture(pending, repo, repo); observer().failIncompleteOnStartup();
    expect(metadata(pending)).toMatchObject({ status: "unavailable", reason: "daemon_restarted" });
  });
});
