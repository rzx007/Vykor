# Jobs Public Surface Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the public/TUI `session.tasks` surface with a truthful Jobs view, add producer-specific background-shell creation, migrate slash commands to Jobs, and remove the obsolete public Task CRUD and unreachable Todo/Swarm UI.

**Architecture:** Existing producers continue to own execution and persistence: `TaskManager` runs shell/dream work, `AgentChildManager` runs child Agents, `WorkflowRunStore` owns workflow state, and Terminal owns PTYs. `DaemonJobService` remains the read/control adapter over those sources. The TUI keeps a disposable `JobRemoteState` cache, uses `listJobs/readJob/cancelJob/sendJob`, and never treats an auxiliary request failure as an empty authoritative result or as a main Agent run failure.

**Tech Stack:** TypeScript 5.7, Hono, React, OpenTUI, Bun test, Vitest, pnpm/Turbo.

**Spec:** `docs/superpowers/specs/2026-08-20-jobs-public-surface-convergence-design.md`

## Global Constraints

- This plan implements design phase 1 only. `parentJobId` and `session.job.created/updated` SSE belong to a separate phase 2 plan.
- Jobs is the only public observation/control surface for already-started long-running work.
- Creation remains producer-specific; do not add `JobCreate`.
- Keep `TaskManager`, `SessionTaskRecord`, `SessionTaskBridge`, and `SessionTaskService` as internal producer/projection infrastructure.
- Do not add a Job database or persist `JobSnapshot`.
- Do not retain `/tasks`, `TaskSnapshot`, `ListTasksOptions`, or Task CRUD compatibility aliases after repository consumers migrate.
- Keep `/schedules/tasks` unchanged. Scheduled tasks are a distinct scheduling domain and are not the removed `/tasks` background-work API.
- Jobs/MCP/detail errors are auxiliary UI errors: they must not clear `submittedRun`, end `localBusy`, or mutate the main Agent run state.
- A failed Jobs request with cached jobs keeps those jobs and marks the remote state as `error`; it never becomes a false successful empty list.
- Every request started by TUI session hydration carries an `AbortSignal` and checks both active session ID and generation before committing state.
- Existing user modifications in `apps/frontend/src/App.tsx`, `apps/desktop/**`, and scheduled-task files are not disposable. Before editing an already-dirty file, capture `git diff -- <file>` and verify after the task that unrelated hunks remain.
- Do not stage unrelated dirty files. For a dirty target file whose pre-existing hunks overlap the implementation, review the combined diff with the user before committing that file.
- Use TDD: add the focused failing test, observe the expected failure, implement the smallest production change, rerun the focused test, then run the affected package typecheck.

## File Map

### New files

- `packages/server/src/http/routes/background-shell.ts` — producer-specific `POST /background-shells` HTTP route.
- `packages/server/src/http/routes/background-shell.test.ts` — route contract and validation tests.
- `apps/frontend/src/jobs/job-remote-state.ts` — pure constructors/transitions for list/detail remote state.
- `apps/frontend/src/jobs/job-remote-state.test.ts` — deterministic state transition tests without React.
- `apps/frontend/src/components/JobsPanel.tsx` — unified Job list, detail, workflow-step detail, cancel/send affordances.
- `apps/frontend/src/components/JobsPanel.test.tsx` — OpenTUI rendering and keyboard behavior tests.

### Modified files

- `packages/server/src/http/session/session-task-service.ts` — give shell creation a concrete `TaskInfo` return type.
- `packages/server/src/http/server.ts` — mount `/background-shells`; later unmount `/tasks`.
- `packages/server/src/http/__test__/http.test.ts` — prove the real server creates a background shell that is immediately readable as a Job, then prove `/tasks` is gone.
- `packages/client/src/types/index.ts` — replace public background Task CRUD input/output types with background-shell creation types.
- `packages/client/src/index.ts` — export the new creation types and stop exporting removed Task CRUD types.
- `packages/client/src/transport/http-client.ts` — add `createBackgroundShell`; later remove Task CRUD methods.
- `packages/client/src/transport/__test__/http-client.test.ts` — verify request/response serialization and absence of old client methods through compile/runtime consumers.
- `apps/frontend/src/hooks/sessionController.ts` — replace `tasks` with `jobState`, `jobs`, `jobDetailState`, and Jobs actions.
- `apps/frontend/src/hooks/useServerSync.ts` — Jobs hydration, stale-response protection, detail/control actions, auxiliary error isolation.
- `apps/frontend/src/hooks/useServerSync.test.tsx` — controller hydration, session switching, errors, read/cancel/send tests.
- `apps/frontend/src/App.tsx` — open the Jobs panel, wire controller actions, and retire the separate Workflow Runs surface.
- `apps/frontend/src/App.test.tsx` — test Jobs callback/action mapping and local `/jobs` opening.
- `packages/server/src/commands/commands.ts` — advertise `/jobs` and `/background`; remove `/tasks`; update `/agents` wording.
- `packages/client/src/commands/session-commands.ts` — implement `/jobs` and `/background`, migrate stats/agents/doctor/dream to Jobs.
- `packages/client/src/commands/__test__/session-commands.test.ts` — command behavior and hard-cut tests.
- `docs/jobs-protocol.md` — document TUI/public client convergence and producer-specific background-shell creation.
- `docs/jobs-task-workflow-convergence.md` — record the UI/client hard cut without changing the already-completed model-tool history.
- `README.md` — replace the stale unreachable SwarmPanel statement with the Jobs Panel status.
- `docs/slash-commands.md` — replace `/tasks` and task-count wording with `/jobs` and `/background`.
- `docs/slash-commands-flow.md` — update command ownership examples and the shared-session command table.
- `docs/client-sync-flow.md` — replace `createTask`/`POST /tasks` with `createBackgroundShell`/`POST /background-shells` and add Jobs hydration.
- `PLAN-REMAINING.md` — update only current command-surface status; preserve internal TaskManager backlog items.

### Deleted files

- `packages/server/src/http/routes/task.ts` — removed public background Task CRUD route.
- `apps/frontend/src/components/TodoPanel.tsx` — unreachable panel with no production data source.
- `apps/frontend/src/components/SwarmPanel.tsx` — unreachable execution-status panel; Swarm remains collaboration infrastructure.
- `apps/frontend/src/components/WorkflowRunsPanel.tsx` — ordinary Workflow Job presentation moves into `JobsPanel`.
- `apps/frontend/src/components/WorkflowRunsPanel.test.tsx` — replaced by Jobs Panel workflow-detail coverage.
- Any Todo/Swarm component test files discovered by `rg --files` during Task 7 — remove only if their corresponding component is deleted and they have no other production subject.

---

### Task 1: Add producer-specific background-shell creation

**Files:**

- Create: `packages/server/src/http/routes/background-shell.ts`
- Create: `packages/server/src/http/routes/background-shell.test.ts`
- Modify: `packages/server/src/http/session/session-task-service.ts`
- Modify: `packages/server/src/http/server.ts`
- Modify: `packages/server/src/http/__test__/http.test.ts`
- Modify: `packages/client/src/types/index.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `packages/client/src/transport/http-client.ts`
- Modify: `packages/client/src/transport/__test__/http-client.test.ts`

**Interfaces:**

- Consumes: `SessionTaskService.create({ sessionId, cwd?, command })`, which creates and projects a shell task; `DaemonJobService.read({ sessionId, jobId })`, which returns the normalized snapshot.
- Produces:

```ts
export interface CreateBackgroundShellInput {
  sessionId: string;
  command: string;
  cwd?: string;
  description?: string;
}

export interface CreateBackgroundShellResult {
  jobId: string;
  snapshot: JobSnapshot;
}

VykorClient.createBackgroundShell(
  input: CreateBackgroundShellInput,
  options?: { signal?: AbortSignal },
): Promise<CreateBackgroundShellResult>
```

- HTTP contract: `POST /background-shells` returns status `201` with `{ jobId, snapshot }`.

- [ ] **Step 1: Write the failing route contract test**

Create `packages/server/src/http/routes/background-shell.test.ts` with a test that asserts trimming, service calls, and the standard result:

```ts
import { describe, expect, it, vi } from "vitest";
import { createBackgroundShellRoutes } from "./background-shell.js";

describe("background shell routes", () => {
  it("creates a shell and returns its normalized Job snapshot", async () => {
    const create = vi.fn(async () => ({ task: { id: "task-1" } }));
    const read = vi.fn(async () => ({
      text: "",
      cursor: 1,
      truncated: false,
      snapshot: {
        id: "task-1",
        kind: "shell" as const,
        label: "pnpm test",
        ownerSession: "s1",
        status: "running" as const,
        capabilities: { read: true, wait: true, send: false, cancel: true },
        cwd: "/repo",
        startedAt: 1,
        updatedAt: 1,
      },
    }));
    const app = createBackgroundShellRoutes({ tasks: { create }, jobs: { read } });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", command: "  pnpm test  " }),
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      sessionId: "s1",
      cwd: undefined,
      command: "pnpm test",
      description: undefined,
    });
    expect(read).toHaveBeenCalledWith({ sessionId: "s1", jobId: "task-1" });
    await expect(response.json()).resolves.toMatchObject({
      jobId: "task-1",
      snapshot: { id: "task-1", kind: "shell", status: "running" },
    });
  });

  it.each([
    [{ command: "echo hi" }, "sessionId is required"],
    [{ sessionId: "s1", command: "   " }, "command is required"],
  ])("rejects invalid input %#", async (body, message) => {
    const app = createBackgroundShellRoutes({
      tasks: { create: vi.fn() },
      jobs: { read: vi.fn() },
    });
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: message });
  });
});
```

- [ ] **Step 2: Run the route test and observe the missing module/export failure**

Run:

```bash
pnpm --filter @vykor/server exec vitest run src/http/routes/background-shell.test.ts
```

Expected: FAIL because `./background-shell.js` and `createBackgroundShellRoutes` do not exist.

- [ ] **Step 3: Give `SessionTaskService.create` a concrete result and accept an optional description**

In `packages/server/src/http/session/session-task-service.ts`, import `TaskInfo` from `@vykor/services`, change the input/result signature, and use the provided description only for the internal task label:

```ts
async create(input: {
  cwd?: string;
  sessionId?: string;
  command: string;
  description?: string;
}): Promise<{ task: TaskInfo }> {
  const scope = this.resolveScope(input);
  const command = input.command.trim();
  if (!command) throw new SessionTaskError(400, "command is required");
  const description = input.description?.trim() || command;
  // existing ID, manager creation, projection, event publication
  const task = await manager.createShellTask({
    // existing options
    command,
    description,
  });
  // existing projection code
  return { task };
}
```

Do not change `list/get/stop`; Jobs still uses them internally.

- [ ] **Step 4: Implement the minimal background-shell route**

Create `packages/server/src/http/routes/background-shell.ts`:

```ts
import { Hono } from "hono";
import type { JobReadResult } from "@vykor/jobs";
import type { SessionTaskService } from "../session/index.js";
import { errorResponse, jsonResponse, readJson } from "../support.js";

export interface BackgroundShellRoutesContext {
  tasks: Pick<SessionTaskService, "create">;
  jobs: { read(input: { sessionId: string; jobId: string }): Promise<JobReadResult> };
}

export function createBackgroundShellRoutes(context: BackgroundShellRoutesContext): Hono {
  return new Hono().post("/", async (c) => {
    const body = await readJson(c);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!sessionId) return errorResponse(400, "sessionId is required");
    if (!command) return errorResponse(400, "command is required");
    try {
      const { task } = await context.tasks.create({
        sessionId,
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        command,
        description: typeof body.description === "string" ? body.description : undefined,
      });
      const result = await context.jobs.read({ sessionId, jobId: task.id });
      return jsonResponse({ jobId: task.id, snapshot: result.snapshot }, 201);
    } catch (error) {
      return errorResponse(400, error instanceof Error ? error.message : String(error));
    }
  });
}
```

Mount it in `packages/server/src/http/server.ts` at `/background-shells` with `this.daemon.tasks` and `this.jobs`. Keep `/tasks` mounted until Task 7 so existing consumers remain green during intermediate commits.

- [ ] **Step 5: Run route and SessionTaskService tests**

Run:

```bash
pnpm --filter @vykor/server exec vitest run src/http/routes/background-shell.test.ts src/http/session/__test__/session-task-service.test.ts
```

Expected: PASS. Existing session-task tests must still prove projection and event publication.

- [ ] **Step 6: Add failing client transport coverage**

In `packages/client/src/transport/__test__/http-client.test.ts`, add:

```ts
it("creates a producer-specific background shell", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const snapshot = jobSnapshot({ id: "task-1", kind: "shell" });
  const client = new VykorClient({
    baseUrl: "http://127.0.0.1:3456",
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ jobId: "task-1", snapshot });
    }) as typeof fetch,
  });

  await expect(client.createBackgroundShell({
    sessionId: "s1",
    command: "pnpm test",
    description: "tests",
  })).resolves.toEqual({ jobId: "task-1", snapshot });
  expect(calls[0]?.url).toBe("http://127.0.0.1:3456/background-shells");
  expect(calls[0]?.init).toMatchObject({
    method: "POST",
    body: JSON.stringify({ sessionId: "s1", command: "pnpm test", description: "tests" }),
  });
});
```

If the file has no `jobSnapshot` factory, declare the full `JobSnapshot` object locally instead of adding an unrelated shared test abstraction.

- [ ] **Step 7: Run the client test and observe the missing method failure**

Run:

```bash
pnpm --filter @vykor/client exec vitest run src/transport/__test__/http-client.test.ts
```

Expected: FAIL because `VykorClient.createBackgroundShell` is not defined.

- [ ] **Step 8: Implement and export the client contract**

Add `CreateBackgroundShellInput` and `CreateBackgroundShellResult` to `packages/client/src/types/index.ts`, importing `JobSnapshot` as a type from `@vykor/jobs`. Re-export them from `packages/client/src/index.ts`. Add this method beside Jobs methods in `packages/client/src/transport/http-client.ts`:

```ts
async createBackgroundShell(
  input: CreateBackgroundShellInput,
  options: { signal?: AbortSignal } = {},
): Promise<CreateBackgroundShellResult> {
  return await this.request<CreateBackgroundShellResult>("/background-shells", {
    method: "POST",
    body: input,
    signal: options.signal,
  });
}
```

- [ ] **Step 9: Add the real-server integration assertion**

In `packages/server/src/http/__test__/http.test.ts`, extend the existing task/job integration setup with this behavior:

```ts
const created = await fetch(`${baseUrl}/background-shells`, {
  method: "POST",
  headers: { ...auth(token), "content-type": "application/json" },
  body: JSON.stringify({ sessionId: "s1", command: successfulShellCommand }),
});
expect(created.status).toBe(201);
const receipt = await created.json() as { jobId: string; snapshot: JobSnapshot };
expect(receipt.snapshot).toMatchObject({ id: receipt.jobId, kind: "shell", ownerSession: "s1" });

const read = await fetch(`${baseUrl}/jobs/${receipt.jobId}?sessionId=s1`, {
  headers: auth(token),
});
expect(read.status).toBe(200);
await expect(read.json()).resolves.toMatchObject({
  snapshot: { id: receipt.jobId, kind: "shell", ownerSession: "s1" },
});
```

Reuse the platform-safe successful shell command already used by this test file; do not introduce a Unix-only command.

- [ ] **Step 10: Run affected tests and typechecks**

Run:

```bash
pnpm --filter @vykor/server exec vitest run src/http/routes/background-shell.test.ts src/http/session/__test__/session-task-service.test.ts src/http/__test__/http.test.ts
pnpm --filter @vykor/client exec vitest run src/transport/__test__/http-client.test.ts
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
```

Expected: all PASS.

- [ ] **Step 11: Commit the producer-specific creation slice**

```bash
git add packages/server/src/http/routes/background-shell.ts packages/server/src/http/routes/background-shell.test.ts packages/server/src/http/session/session-task-service.ts packages/server/src/http/server.ts packages/server/src/http/__test__/http.test.ts packages/client/src/types/index.ts packages/client/src/index.ts packages/client/src/transport/http-client.ts packages/client/src/transport/__test__/http-client.test.ts
git commit -m "feat(jobs): add background shell creation endpoint"
```

Before committing, `git diff --cached --name-only` must contain exactly the files above.

---

### Task 2: Define truthful Jobs remote-state transitions

**Files:**

- Create: `apps/frontend/src/jobs/job-remote-state.ts`
- Create: `apps/frontend/src/jobs/job-remote-state.test.ts`
- Modify: `apps/frontend/src/hooks/sessionController.ts`

**Interfaces:**

- Consumes: `JobSnapshot` and `JobReadResult` from `@vykor/client` re-exports.
- Produces:

```ts
export type JobRemoteState =
  | { status: "idle"; jobs: JobSnapshot[] }
  | { status: "loading"; jobs: JobSnapshot[] }
  | { status: "ready"; jobs: JobSnapshot[]; refreshedAt: number }
  | { status: "error"; jobs: JobSnapshot[]; error: string; refreshedAt?: number };

export type JobDetailRemoteState =
  | { status: "idle" }
  | { status: "loading"; jobId: string; previous?: JobReadResult }
  | { status: "ready"; jobId: string; result: JobReadResult; refreshedAt: number }
  | { status: "error"; jobId: string; error: string; previous?: JobReadResult };

export function beginJobList(previous: JobRemoteState): JobRemoteState;
export function resolveJobList(jobs: JobSnapshot[], now: number): JobRemoteState;
export function rejectJobList(previous: JobRemoteState, error: string): JobRemoteState;
export function mergeJobSnapshot(state: JobRemoteState, snapshot: JobSnapshot, now: number): JobRemoteState;
export function validateJobSnapshots(
  value: unknown,
  ownerSession: string,
): { jobs: JobSnapshot[]; error?: string };
```

- [ ] **Step 1: Write failing pure-state tests**

Create `apps/frontend/src/jobs/job-remote-state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { JobSnapshot } from "@vykor/client";
import { beginJobList, mergeJobSnapshot, rejectJobList, resolveJobList } from "./job-remote-state";

const job: JobSnapshot = {
  id: "job-1",
  kind: "agent",
  label: "review",
  ownerSession: "s1",
  status: "running",
  capabilities: { read: true, wait: true, send: true, cancel: true },
  cwd: "/repo",
  startedAt: 1,
  updatedAt: 1,
};

describe("JobRemoteState", () => {
  test("loading preserves cached jobs", () => {
    expect(beginJobList({ status: "ready", jobs: [job], refreshedAt: 10 }))
      .toEqual({ status: "loading", jobs: [job] });
  });

  test("failure preserves cached jobs and does not become empty-ready", () => {
    expect(rejectJobList({ status: "ready", jobs: [job], refreshedAt: 10 }, "offline"))
      .toEqual({ status: "error", jobs: [job], error: "offline", refreshedAt: 10 });
  });

  test("success distinguishes an authoritative empty result", () => {
    expect(resolveJobList([], 20)).toEqual({ status: "ready", jobs: [], refreshedAt: 20 });
  });

  test("control responses update one snapshot without dropping siblings", () => {
    const sibling = { ...job, id: "job-2" };
    const stopped = { ...job, status: "killed" as const, updatedAt: 30 };
    expect(mergeJobSnapshot({ status: "ready", jobs: [job, sibling], refreshedAt: 10 }, stopped, 30))
      .toMatchObject({ jobs: [stopped, sibling] });
  });

  test("invalid producer records are skipped without inventing shared IDs", () => {
    expect(validateJobSnapshots([
      job,
      { ...job, id: "" },
      { ...job, id: "foreign", ownerSession: "s2" },
    ], "s1")).toEqual({
      jobs: [job],
      error: "Ignored 2 invalid Job snapshots.",
    });
  });
});
```

- [ ] **Step 2: Run the pure test and observe the missing module failure**

Run:

```bash
pnpm --dir apps/frontend exec bun test src/jobs/job-remote-state.test.ts
```

Expected: FAIL because `job-remote-state.ts` does not exist.

- [ ] **Step 3: Implement the pure transitions**

Create `apps/frontend/src/jobs/job-remote-state.ts`. Copy arrays before returning them, retain `refreshedAt` from ready/error state on failure, and replace by ID in `mergeJobSnapshot`:

```ts
export function rejectJobList(previous: JobRemoteState, error: string): JobRemoteState {
  const refreshedAt = "refreshedAt" in previous ? previous.refreshedAt : undefined;
  return {
    status: "error",
    jobs: [...previous.jobs],
    error,
    ...(refreshedAt !== undefined ? { refreshedAt } : {}),
  };
}

export function mergeJobSnapshot(
  state: JobRemoteState,
  snapshot: JobSnapshot,
  now: number,
): JobRemoteState {
  const found = state.jobs.some((job) => job.id === snapshot.id);
  const jobs = found
    ? state.jobs.map((job) => job.id === snapshot.id ? snapshot : job)
    : [snapshot, ...state.jobs];
  return { status: "ready", jobs, refreshedAt: now };
}
```

Implement `beginJobList` and `resolveJobList` exactly as their signatures describe.

Implement `validateJobSnapshots` with explicit guards for a non-empty `id`, exact `ownerSession`, supported `kind`/`status`, a string `label`/`cwd`, finite timestamps, and four boolean capabilities. Skip invalid entries and report their count. Never substitute `"unknown"` for a missing ID. A non-array response returns `{ jobs: [], error: "Jobs response must be an array." }`.

- [ ] **Step 4: Replace the controller Task surface**

In `apps/frontend/src/hooks/sessionController.ts`:

1. Remove the `TaskSnapshot` import.
2. Import `JobSnapshot` and `JobReadResult`.
3. Import `JobRemoteState` and `JobDetailRemoteState` from the new module.
4. Replace `tasks: TaskSnapshot[]` with:

```ts
jobState: JobRemoteState;
jobs: JobSnapshot[];
jobDetailState: JobDetailRemoteState;
```

5. Add controller actions:

```ts
export type JobRequestAction =
  | { type: "job_request"; job_action: "open" | "refresh" }
  | { type: "job_request"; job_action: "select"; job_id: string }
  | { type: "job_request"; job_action: "cancel"; job_id: string; reason?: string }
  | { type: "job_request"; job_action: "send"; job_id: string; data: string };
```

Add `JobRequestAction` to `TuiAction`. Keep existing Workflow types temporarily; Task 5 removes them after the Jobs panel absorbs workflow detail.

- [ ] **Step 5: Run state tests and frontend typecheck**

Run:

```bash
pnpm --dir apps/frontend exec bun test src/jobs/job-remote-state.test.ts
pnpm --filter @vykor/frontend check-types
```

Expected: the pure tests PASS; typecheck FAILS only at `useServerSync` and test fixtures still returning `tasks`, which Task 3 immediately migrates. Do not commit this temporarily red task separately.

---

### Task 3: Hydrate and control Jobs in `useServerSync`

**Files:**

- Modify: `apps/frontend/src/hooks/useServerSync.ts`
- Modify: `apps/frontend/src/hooks/useServerSync.test.tsx`
- Modify: `apps/frontend/src/hooks/sessionController.ts`
- Test: `apps/frontend/src/jobs/job-remote-state.test.ts`

**Interfaces:**

- Consumes: Task 2 `JobRemoteState`, `JobDetailRemoteState`, and transition helpers; client `listJobs/readJob/cancelJob/sendJob`.
- Produces: a `TuiSessionController` whose `jobs` is always `jobState.jobs`, plus `job_request` dispatch behavior.

- [ ] **Step 1: Replace old hydration expectations with failing Jobs expectations**

In `apps/frontend/src/hooks/useServerSync.test.tsx`, update the current `/tasks` hydration test to mock `/jobs` and assert the observable controller state:

```ts
expect(captured?.jobState.status).toBe("ready");
expect(captured?.jobs).toEqual([expect.objectContaining({ id: "agent-1", kind: "agent" })]);
expect(calls.some((call) => call.startsWith("/tasks?"))).toBe(false);
expect(calls.some((call) => call.startsWith("/jobs?"))).toBe(true);
```

Add a failure test that begins with one successful list, then rejects refresh and asserts:

```ts
expect(captured?.jobState).toMatchObject({
  status: "error",
  jobs: [expect.objectContaining({ id: "agent-1" })],
  error: "jobs unavailable",
});
expect(captured?.busy).toBe(false);
```

Add a session-switch test in which session A resolves after session B and assert only session B jobs remain.

- [ ] **Step 2: Run the focused hook tests and observe missing `jobState` failures**

Run:

```bash
pnpm --dir apps/frontend exec bun test src/hooks/useServerSync.test.tsx
```

Expected: FAIL because the hook still returns `tasks` and calls `listTasks`.

- [ ] **Step 3: Add Jobs list/detail state and refs**

In `useServerSync.ts`, remove `TaskSnapshot`, `tasks`, and `setTasks`. Add:

```ts
const [jobState, setJobState] = useState<JobRemoteState>({ status: "idle", jobs: [] });
const [jobDetailState, setJobDetailState] = useState<JobDetailRemoteState>({ status: "idle" });
const jobStateRef = useRef(jobState);
const jobGenerationRef = useRef(0);
const jobDetailGenerationRef = useRef(0);
```

Synchronize `jobStateRef.current` in an effect. When the active session changes, reset detail to idle and begin a new list generation.

- [ ] **Step 4: Implement `refreshJobs` with abort and generation guards**

Add a callback with this control flow:

```ts
const refreshJobs = useCallback(async (): Promise<void> => {
  const client = clientRef.current;
  const sessionId = activeSessionIdRef.current;
  const generation = ++jobGenerationRef.current;
  if (!client || !sessionId) {
    setJobState({ status: "idle", jobs: [] });
    return;
  }
  jobsAbortRef.current?.abort();
  const controller = new AbortController();
  jobsAbortRef.current = controller;
  setJobState((current) => beginJobList(current));
  try {
    const response = await client.listJobs({
      sessionId,
      includeFinished: true,
      limit: 100,
      signal: controller.signal,
    });
    if (activeSessionIdRef.current !== sessionId || jobGenerationRef.current !== generation) return;
    const validated = validateJobSnapshots(response, sessionId);
    if (validated.error) {
      const validationError = validated.error;
      const now = Date.now();
      setJobState((current) => validated.jobs.length > 0
        ? { status: "error", jobs: validated.jobs, error: validationError, refreshedAt: now }
        : rejectJobList(current, validationError));
      onErrorRef.current?.(`Jobs: ${validationError}`);
    } else {
      setJobState(resolveJobList(validated.jobs, Date.now()));
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (activeSessionIdRef.current !== sessionId || jobGenerationRef.current !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    setJobState((current) => rejectJobList(current, message));
    onErrorRef.current?.(`Jobs: ${message}`);
  } finally {
    if (jobsAbortRef.current === controller) jobsAbortRef.current = null;
  }
}, []);
```

Declare `const jobsAbortRef = useRef<AbortController | null>(null)`. The active-session effect calls `void refreshJobs()` and its cleanup calls `jobsAbortRef.current?.abort()`. Manual refresh uses the same callback, so a newer refresh always aborts the older request. Do not return a cleanup function from the async callback.

Replace the old `client.listTasks({ sessionId })` hydration branch with `loadJobs`. Keep MCP hydration separate so one request failing cannot overwrite the other domain.

- [ ] **Step 5: Separate auxiliary errors from main run errors**

Keep `reportError` for main command/run failures. Add:

```ts
const reportAuxiliaryError = useCallback((scope: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  onErrorRef.current?.(`${scope}: ${message}`);
}, []);
```

Use it for MCP, Jobs list, Job read/cancel/send, and Workflow detail loading. It must not call `setSubmittedRun(null)`, `setLocalBusy(false)`, or global connection teardown. The MCP failure branch may keep its own previous servers or expose its existing empty state, but must not alter Jobs or run state.

- [ ] **Step 6: Add failing read/cancel/send controller tests**

Add tests that dispatch:

```ts
captured?.sendRequest({ type: "job_request", job_action: "select", job_id: "agent-1" });
captured?.sendRequest({ type: "job_request", job_action: "cancel", job_id: "agent-1", reason: "TUI" });
captured?.sendRequest({ type: "job_request", job_action: "send", job_id: "agent-1", data: "continue" });
```

Assert requests go to:

```text
GET  /jobs/agent-1?sessionId=s1
POST /jobs/agent-1/cancel
POST /jobs/agent-1/input
```

Assert a cancel response with `status: "killed"` replaces only `agent-1` in `jobState.jobs` and triggers a list refresh. Assert a failed send leaves the list/detail snapshot intact and surfaces an auxiliary error.

- [ ] **Step 7: Implement Jobs actions**

Add `job_request` handling to `sendRequest`:

```ts
case "job_request": {
  if (!client) {
    reportAuxiliaryError("Jobs", "The daemon client is not connected.");
    return;
  }
  const currentSessionId = activeSessionIdRef.current;
  if (!currentSessionId) return;
  switch (action.job_action) {
    case "open":
    case "refresh":
      await refreshJobs();
      return;
    case "select":
      await loadJobDetail(client, currentSessionId, action.job_id);
      return;
    case "cancel": {
      const snapshot = await client.cancelJob(action.job_id, {
        sessionId: currentSessionId,
        reason: action.reason,
      });
      if (activeSessionIdRef.current !== currentSessionId) return;
      setJobState((current) => mergeJobSnapshot(current, snapshot, Date.now()));
      await loadJobDetail(client, currentSessionId, action.job_id);
      await refreshJobs();
      return;
    }
    case "send":
      await client.sendJob(action.job_id, { sessionId: currentSessionId, data: action.data });
      await loadJobDetail(client, currentSessionId, action.job_id);
      return;
  }
}
```

Implement `loadJobDetail` with its own generation guard and `JobDetailRemoteState` transitions. On read failure, retain the previous result only when it belongs to the same `jobId`.

- [ ] **Step 8: Return the new controller shape**

Return:

```ts
jobState,
jobs: jobState.jobs,
jobDetailState,
```

Remove `tasks` from the return value and dependency list. Trigger a Jobs refresh after a submitted main run reaches any terminal state, but do not make that refresh part of clearing `submittedRun`; run completion remains successful even when refresh fails.

- [ ] **Step 9: Run hook/state tests and typecheck**

Run:

```bash
pnpm --dir apps/frontend exec bun test src/jobs/job-remote-state.test.ts src/hooks/useServerSync.test.tsx
pnpm --filter @vykor/frontend check-types
```

Expected: PASS. There must be no `/tasks` call in production hook code.

- [ ] **Step 10: Commit remote state and controller behavior**

```bash
git add apps/frontend/src/jobs/job-remote-state.ts apps/frontend/src/jobs/job-remote-state.test.ts apps/frontend/src/hooks/sessionController.ts apps/frontend/src/hooks/useServerSync.ts apps/frontend/src/hooks/useServerSync.test.tsx
git commit -m "feat(tui): hydrate and control unified Jobs"
```

---

### Task 4: Build the unified Jobs Panel

**Files:**

- Create: `apps/frontend/src/components/JobsPanel.tsx`
- Create: `apps/frontend/src/components/JobsPanel.test.tsx`

**Interfaces:**

- Consumes: `JobRemoteState`, `JobDetailRemoteState`, `JobSnapshot`.
- Produces:

```ts
export interface JobsPanelProps {
  state: JobRemoteState;
  detailState: JobDetailRemoteState;
  onRefresh(): void;
  onSelect(jobId: string): void;
  onCancel(jobId: string): void;
}
```

- [ ] **Step 1: Write failing rendering tests for all remote states**

Create `JobsPanel.test.tsx` using `testRender` and `ThemeProvider`. Cover these exact assertions:

```ts
expect(render({ status: "loading", jobs: [] })).toContain("Loading Jobs");
expect(render({ status: "ready", jobs: [], refreshedAt: 10 })).toContain("No Jobs in this session");
expect(render({ status: "error", jobs: [], error: "offline" })).toContain("Jobs unavailable: offline");
expect(render({ status: "error", jobs: [agentJob], error: "offline" })).toContain("Showing cached Jobs");
```

For a populated list, assert `workflow`, `terminal`, `shell`, `agent`, `dream`, and their statuses are visible. Also assert finished jobs use a completed/killed/failed marker distinct from running.

- [ ] **Step 2: Write failing keyboard capability tests**

Render running Agent and shell jobs, send keyboard input, and assert:

```ts
mockInput.pressKey("down");
mockInput.pressKey("return");
expect(selected).toEqual(["shell-1"]);

mockInput.pressKey("c");
expect(cancelled).toEqual(["shell-1"]); // only when capability.cancel is true

```

The panel must not call `onCancel` when the selected snapshot capability is false. Phase 1 keeps `JobSend` in the controller/client contract but does not expose an `s` shortcut: the current TUI has no reusable text-input dialog, and sending an empty string would be a misleading control.

- [ ] **Step 3: Run the component test and observe the missing component failure**

Run:

```bash
pnpm --dir apps/frontend exec bun test src/components/JobsPanel.test.tsx
```

Expected: FAIL because `JobsPanel.tsx` does not exist.

- [ ] **Step 4: Implement list and remote-state rendering**

Use `useListNavigation`, `useKeyboard`, and theme colors following existing OpenTUI panels. Render this stable header/help text:

```text
Jobs
r refresh  enter detail  c cancel  k kind  f status
```

Keep the list window bounded to seven rows. Cycle kind and status filters through a pure `nextFilter` helper. Filtering changes only the visible rows; it must not mutate `state.jobs` or the total count.

- [ ] **Step 5: Render generic Job detail**

For `detailState.status === "ready"`, render:

```text
DETAIL
<kind> <status> <label>
id: <id>
cwd: <cwd>
started: <ISO timestamp>
<text output, bounded to the last visible lines>
```

Show `Loading detail…` and `Detail unavailable: <message>` for the other states. If the error state has `previous`, render the cached previous result below the error banner.

- [ ] **Step 6: Render Workflow producer details inside the same panel**

When `result.snapshot.kind === "workflow"`, read `result.details.plan.tasks` defensively and render a `STEPS` section. Validate each entry with small local guards:

```ts
type WorkflowStepRow = { taskId: string; status: string; summary?: string };
```

Ignore malformed entries rather than inventing an `unknown` ID. Render at most five steps and a `+N steps` line for the remainder. Render reconciliation summary from `details.reconciliation` when present. Do not render a second Workflow run list; the Jobs list is the only top-level list.

- [ ] **Step 7: Keep JobSend out of the phase 1 panel UI**

Do not render an `s send` hint and do not add `onSend` to `JobsPanelProps`. The existing TUI has selection dialogs but no reusable text-input dialog; phase 1 therefore keeps `sendJob` and `job_request/send` tested at the controller boundary without exposing an empty or lossy UI action. A later focused input-dialog change may wire the already-defined controller action.

- [ ] **Step 8: Run panel tests and frontend typecheck**

Run:

```bash
pnpm --dir apps/frontend exec bun test src/components/JobsPanel.test.tsx
pnpm --filter @vykor/frontend check-types
```

Expected: PASS with no React `act` warning and no state update after `renderer.destroy()`.

- [ ] **Step 9: Commit the panel**

```bash
git add apps/frontend/src/components/JobsPanel.tsx apps/frontend/src/components/JobsPanel.test.tsx
git commit -m "feat(tui): add unified Jobs panel"
```

---

### Task 5: Make Jobs the only top-level background-work panel

**Files:**

- Modify: `apps/frontend/src/App.tsx`
- Modify: `apps/frontend/src/App.test.tsx`
- Modify: `apps/frontend/src/hooks/sessionController.ts`
- Modify: `apps/frontend/src/hooks/useServerSync.ts`
- Modify: `apps/frontend/src/hooks/useServerSync.test.tsx`
- Delete: `apps/frontend/src/components/WorkflowRunsPanel.tsx`
- Delete: `apps/frontend/src/components/WorkflowRunsPanel.test.tsx`

**Interfaces:**

- Consumes: Task 3 controller Jobs actions and Task 4 `JobsPanelProps`.
- Produces: `/jobs`, `/workflow`, and `/workflows` all open the unified Jobs panel; Workflow Steps render through selected Workflow `JobReadResult.details`.

- [ ] **Step 1: Capture and review the pre-existing App diff**

Run:

```bash
git diff -- apps/frontend/src/App.tsx
```

Record which hunks predate this task. The current file already contains Workflow panel work. The finished implementation intentionally supersedes the separate Workflow panel, but must preserve unrelated theme, dialog, history, sidebar, keyboard, and session-switch behavior.

- [ ] **Step 2: Replace callback-mapping tests with failing Jobs callbacks**

In `apps/frontend/src/App.test.tsx`, replace `createWorkflowRunsPanelCallbacks` coverage with:

```ts
const callbacks = createJobsPanelCallbacks((action) => actions.push(action));
callbacks.onRefresh();
callbacks.onSelect("agent-1");
callbacks.onCancel("agent-1");

expect(actions).toEqual([
  { type: "job_request", job_action: "refresh" },
  { type: "job_request", job_action: "select", job_id: "agent-1" },
  {
    type: "job_request",
    job_action: "cancel",
    job_id: "agent-1",
    reason: "Cancelled from TUI",
  },
]);
```

Add a testable pure command predicate or exported callback that proves `/jobs`, `/workflow`, and `/workflows` request the same panel open action.

- [ ] **Step 3: Run App tests and observe missing mapping failures**

Run:

```bash
pnpm --dir apps/frontend exec bun test src/App.test.tsx
```

Expected: FAIL because `createJobsPanelCallbacks` does not exist.

- [ ] **Step 4: Wire `JobsPanel` into `App.tsx`**

Replace `workflowPanelOpen` with `jobsPanelOpen`; replace the Workflow component import with `JobsPanel`. Add:

```ts
type JobsPanelCallbacks = Omit<JobsPanelProps, "state" | "detailState">;

export function createJobsPanelCallbacks(
  sendRequest: (action: TuiAction) => void,
): JobsPanelCallbacks {
  return {
    onRefresh: () => sendRequest({ type: "job_request", job_action: "refresh" }),
    onSelect: (jobId) => sendRequest({ type: "job_request", job_action: "select", job_id: jobId }),
    onCancel: (jobId) => sendRequest({
      type: "job_request",
      job_action: "cancel",
      job_id: jobId,
      reason: "Cancelled from TUI",
    }),
  };
}
```

Open behavior:

```ts
if (["/jobs", "/workflow", "/workflows"].includes(line.trim())) {
  setJobsPanelOpen(true);
  session.sendRequest({ type: "job_request", job_action: "open" });
  return true;
}
```

Render:

```tsx
<JobsPanel
  state={session.jobState}
  detailState={session.jobDetailState}
  {...jobsPanelCallbacks}
/>
```

Escape and session switch close the Jobs panel. Keep dialog priority and busy Escape behavior unchanged.

- [ ] **Step 5: Remove the duplicate Workflow controller surface**

After the App no longer dispatches `workflow_request`:

1. Remove `WorkflowRequestAction` from `sessionController.ts`.
2. Remove `workflowState` from `TuiSessionController`.
3. Remove `workflowStateFromJobs`, Workflow refs/state, `refreshWorkflowState`, and the `workflow_request` switch branch from `useServerSync.ts`.
4. Move only reusable defensive Workflow detail parsing needed by `JobsPanel` into a small exported helper in `JobsPanel.tsx` or `apps/frontend/src/jobs/workflow-job-detail.ts` if it exceeds roughly 80 lines.
5. Update hook tests so Workflow `list/read/cancel` is covered through `job_request` and no independent workflow list request exists.

- [ ] **Step 6: Delete the old Workflow panel and tests**

Delete:

```text
apps/frontend/src/components/WorkflowRunsPanel.tsx
apps/frontend/src/components/WorkflowRunsPanel.test.tsx
```

Run `rg -n "WorkflowRunsPanel|workflow_request|workflowState" apps/frontend/src` and require no production matches.

- [ ] **Step 7: Run frontend tests and typecheck**

Run:

```bash
pnpm --dir apps/frontend exec bun test src/App.test.tsx src/components/JobsPanel.test.tsx src/hooks/useServerSync.test.tsx
pnpm --filter @vykor/frontend check-types
```

Expected: PASS.

- [ ] **Step 8: Review preservation of the dirty App file**

Run:

```bash
git diff -- apps/frontend/src/App.tsx
```

Compare with Step 1. Theme selection, permission dialog, model picker, coordinator toggle, sessions, prompt history, sidebar, clipboard, and exit behavior must remain unless a hunk was strictly part of the replaced Workflow panel.

- [ ] **Step 9: Commit the unified panel integration**

Stage clean files first. Because `App.tsx` was dirty before this task, do not silently stage an unreviewed combined diff. After confirming its baseline hunks are preserved and the combined change is authorized:

```bash
git add apps/frontend/src/App.tsx apps/frontend/src/App.test.tsx apps/frontend/src/hooks/sessionController.ts apps/frontend/src/hooks/useServerSync.ts apps/frontend/src/hooks/useServerSync.test.tsx apps/frontend/src/components/WorkflowRunsPanel.tsx apps/frontend/src/components/WorkflowRunsPanel.test.tsx
git commit -m "refactor(tui): converge workflow views into Jobs"
```

---

### Task 6: Migrate slash commands and diagnostics from Tasks to Jobs

**Files:**

- Modify: `packages/server/src/commands/commands.ts`
- Modify: `packages/client/src/commands/session-commands.ts`
- Modify: `packages/client/src/commands/__test__/session-commands.test.ts`
- Modify: `apps/frontend/src/hooks/useServerSync.test.tsx`

**Interfaces:**

- Consumes: `VykorClient.listJobs/readJob/cancelJob/createBackgroundShell`.
- Produces:

```text
/jobs [list]
/jobs show <jobId>
/jobs cancel <jobId>
/background <command>
```

- `/stats`, `/agents`, `/doctor`, and `/dream` use Jobs terminology and data.

- [ ] **Step 1: Add failing command tests for the new surface**

In `session-commands.test.ts`, create a fake client with `listJobs`, `readJob`, `cancelJob`, and `createBackgroundShell`. Add tests that assert:

```ts
await dispatchSessionCommand({ name: "/jobs", args: "" }, host);
expect(listJobs).toHaveBeenCalledWith({ sessionId: "s1", includeFinished: true, limit: 100 });
expect(presented).toContainEqual(expect.objectContaining({ title: "Jobs" }));

await dispatchSessionCommand({ name: "/jobs", args: "show agent-1" }, host);
expect(readJob).toHaveBeenCalledWith("agent-1", { sessionId: "s1" });

await dispatchSessionCommand({ name: "/jobs", args: "cancel agent-1" }, host);
expect(cancelJob).toHaveBeenCalledWith("agent-1", {
  sessionId: "s1",
  reason: "Cancelled from slash command",
});

await dispatchSessionCommand({ name: "/background", args: "pnpm test" }, host);
expect(createBackgroundShell).toHaveBeenCalledWith({ sessionId: "s1", command: "pnpm test" });
expect(emitted.at(-1)).toBe("Background shell started: shell-1. Use /jobs to inspect it.");
```

Add a hard-cut test:

```ts
await expect(dispatchSessionCommand({ name: "/tasks", args: "" }, host))
  .resolves.toBe("unhandled");
```

- [ ] **Step 2: Add failing migration tests for stats, agents, doctor, and dream**

Assert:

- `/stats` counts `jobs.length` and labels it `jobs`, not `background_tasks`.
- `/agents` calls `listJobs({ sessionId, kinds: ["agent"], includeFinished: true, limit: 100 })` and renders `Agent Jobs`.
- `/doctor` calls `listJobs`, keeps MCP failures independent, and renders `Jobs:`.
- `/dream` output says `Dream started as Job <id>. Use /jobs to inspect it.`. If the current dream response only returns `taskId`, treat that value as the Job ID at the presentation boundary; do not change the dream producer in this task.

- [ ] **Step 3: Run command tests and observe the old `/tasks` behavior**

Run:

```bash
pnpm --filter @vykor/client exec vitest run src/commands/__test__/session-commands.test.ts
```

Expected: FAIL because `/jobs` and `/background` are not handled and `/tasks` is still active.

- [ ] **Step 4: Replace `/tasks` command dispatch**

In `shouldPresentSlashOutput`, make `/jobs` list/show read-only and remove `/tasks`. Implement `/jobs` formatting from `JobSnapshot`:

```text
Jobs (N):

  <id> [<status>] <kind>: <label>
```

For `show`, render the normalized snapshot fields and `JobReadResult.text`. For `cancel`, display the returned snapshot status. Invalid syntax must emit exactly:

```text
Usage: /jobs [list | show ID | cancel ID]
```

Implement `/background`; reject an empty command with:

```text
Usage: /background <command>
```

- [ ] **Step 5: Migrate secondary consumers**

Replace every `listTasks` use in `session-commands.ts`:

```ts
client.listJobs({ sessionId, includeFinished: true, limit: 100 })
```

Use a narrower `kinds: ["agent"]` query for `/agents`. Do not convert Schedule commands or model `TaskCreate` references.

- [ ] **Step 6: Update the server command catalog**

In `packages/server/src/commands/commands.ts`, replace `/tasks` with:

```ts
{
  name: "/jobs",
  description: "List, inspect, or cancel Jobs (list | show ID | cancel ID)",
  kind: "session",
  source: "builtin",
  argumentHint: "[list|show ID|cancel ID]",
},
{
  name: "/background",
  description: "Start a background shell and return its Job ID",
  kind: "session",
  source: "builtin",
  argumentHint: "<command>",
},
```

Change `/agents` description to `Show Agent Jobs`.

- [ ] **Step 7: Update TUI command fixtures**

In `useServerSync.test.tsx`, replace command catalog fixtures containing `/tasks` with `/jobs` and `/background`. Keep one negative assertion that the merged command list does not contain `/tasks`.

- [ ] **Step 8: Run client, server command, frontend tests, and typechecks**

Run:

```bash
pnpm --filter @vykor/client exec vitest run src/commands/__test__/session-commands.test.ts
pnpm --filter @vykor/server exec vitest run src/commands
pnpm --dir apps/frontend exec bun test src/hooks/useServerSync.test.tsx
pnpm --filter @vykor/client check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/frontend check-types
```

Expected: PASS.

- [ ] **Step 9: Commit the command migration**

```bash
git add packages/server/src/commands/commands.ts packages/client/src/commands/session-commands.ts packages/client/src/commands/__test__/session-commands.test.ts apps/frontend/src/hooks/useServerSync.test.tsx
git commit -m "refactor(commands): replace background tasks with Jobs"
```

---

### Task 7: Remove obsolete public Task CRUD and unreachable panels

**Files:**

- Delete: `packages/server/src/http/routes/task.ts`
- Modify: `packages/server/src/http/server.ts`
- Modify: `packages/server/src/http/routes/__test__/routes.test.ts`
- Modify: `packages/server/src/http/__test__/http.test.ts`
- Modify: `packages/client/src/types/index.ts`
- Modify: `packages/client/src/index.ts`
- Modify: `packages/client/src/transport/http-client.ts`
- Modify: `packages/client/src/transport/__test__/http-client.test.ts`
- Delete: `apps/frontend/src/components/TodoPanel.tsx`
- Delete: `apps/frontend/src/components/SwarmPanel.tsx`
- Delete: matching orphan component tests if present

**Interfaces:**

- Consumes: all repository public consumers migrated in Tasks 1–6.
- Produces: no `/tasks` HTTP route, no public Task CRUD client methods/types, and no unreachable Todo/Swarm execution-status UI.

- [ ] **Step 1: Prove repository consumers are ready for the hard cut**

Run:

```bash
rg -n --glob '!docs/**' --glob '!node_modules/**' "listTasks\(|getTask\(|stopTask\(|createTask\(|TaskSnapshot|ListTasksOptions|CreateTaskInput|/tasks\b" apps packages
```

Classify every match before deleting anything:

- Keep `TaskManager.listTasks`, scheduled-task service methods, `/schedules/tasks`, and model `TaskCreate`.
- Remove background HTTP/client/TUI matches.
- Internal `SessionTaskService.list/get/stop` matches used by `DaemonJobService` remain.

The command must show no unmigrated public consumer of `VykorClient` Task CRUD.

- [ ] **Step 2: Add failing hard-cut HTTP assertions**

In `packages/server/src/http/__test__/http.test.ts`, after server startup assert:

```ts
const oldList = await fetch(`${baseUrl}/tasks?sessionId=s1`, { headers: auth(token) });
expect(oldList.status).toBe(404);

const oldCreate = await fetch(`${baseUrl}/tasks`, {
  method: "POST",
  headers: { ...auth(token), "content-type": "application/json" },
  body: JSON.stringify({ sessionId: "s1", command: successfulShellCommand }),
});
expect(oldCreate.status).toBe(404);
```

Keep the Task 1 assertion that `/background-shells` works and returns a Job.

- [ ] **Step 3: Run the server integration test and observe `/tasks` still exists**

Run:

```bash
pnpm --filter @vykor/server exec vitest run src/http/__test__/http.test.ts
```

Expected: FAIL because `/tasks` returns a success/validation response instead of 404.

- [ ] **Step 4: Remove the HTTP Task route**

Delete `packages/server/src/http/routes/task.ts`. Remove its import and mount from `packages/server/src/http/server.ts`. Remove the obsolete `createTaskRoutes` unit block/import from `packages/server/src/http/routes/__test__/routes.test.ts`.

Do not delete `SessionTaskService` or `SessionTaskBridge`: `DaemonJobService` and `/background-shells` still depend on them.

- [ ] **Step 5: Remove client Task CRUD types and methods**

Delete from `packages/client/src/types/index.ts`:

```text
TaskSnapshot
ListTasksOptions
CreateTaskInput
```

Delete their exports from `packages/client/src/index.ts`, their imports from `http-client.ts`, and these methods:

```text
listTasks
getTask
stopTask
createTask
```

Do not remove ScheduledTask types/methods or Jobs exports.

- [ ] **Step 6: Delete unreachable Todo and Swarm panels**

Before deletion, run:

```bash
rg -n "TodoPanel|SwarmPanel|SwarmTeammateSnapshot|SwarmNotificationSnapshot|todoMarkdown|swarmTeammates|swarmNotifications" apps/frontend/src
```

Delete `TodoPanel.tsx` and `SwarmPanel.tsx`. If their only remaining references are dedicated component tests or UI-only snapshot types, delete those tests/types in the same change. Preserve the `packages/swarm` runtime and any team/mailbox types used outside these panels.

- [ ] **Step 7: Run hard-cut audits**

Run:

```bash
rg -n --glob '!docs/**' --glob '!node_modules/**' "VykorClient\.(listTasks|getTask|stopTask|createTask)|client\.(listTasks|getTask|stopTask|createTask)|TaskSnapshot|ListTasksOptions|CreateTaskInput" apps packages
rg -n --glob '!node_modules/**' 'name: "/tasks"|slash\?\.name === "/tasks"|route\("/tasks"' apps packages
```

Expected: no matches. A separate audit for `/schedules/tasks`, `TaskManager`, `SessionTaskRecord`, and `TaskCreate` should still find the intentionally retained internal/domain concepts.

- [ ] **Step 8: Run affected package tests and typechecks**

Run:

```bash
pnpm --filter @vykor/server exec vitest run src/http/__test__/http.test.ts src/http/routes src/http/session
pnpm --filter @vykor/client exec vitest run
pnpm --dir apps/frontend exec bun test src
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
pnpm --filter @vykor/frontend check-types
```

Expected: PASS.

- [ ] **Step 9: Commit the hard cut**

```bash
git add packages/server/src/http/routes/task.ts packages/server/src/http/server.ts packages/server/src/http/routes/__test__/routes.test.ts packages/server/src/http/__test__/http.test.ts packages/client/src/types/index.ts packages/client/src/index.ts packages/client/src/transport/http-client.ts packages/client/src/transport/__test__/http-client.test.ts apps/frontend/src/components/TodoPanel.tsx apps/frontend/src/components/SwarmPanel.tsx
git add -u apps/frontend/src/components
git commit -m "refactor(jobs): remove obsolete public Task surfaces"
```

Inspect `git diff --cached --name-only` before committing; `git add -u apps/frontend/src/components` must not stage an unrelated user deletion/modification.

---

### Task 8: Update protocol documentation and verify phase 1 end-to-end

**Files:**

- Modify: `docs/jobs-protocol.md`
- Modify: `docs/jobs-task-workflow-convergence.md`
- Modify: `README.md`
- Modify: `docs/slash-commands.md`
- Modify: `docs/slash-commands-flow.md`
- Modify: `docs/client-sync-flow.md`
- Modify: `PLAN-REMAINING.md`
- Test: all affected packages

**Interfaces:**

- Consumes: completed phase 1 behavior.
- Produces: documentation that matches the actual public API and a verified repository baseline for the phase 2 hierarchy/SSE plan.

- [ ] **Step 1: Audit documentation with domain-aware patterns**

Run:

```bash
rg -n --glob '*.md' "/tasks\b|session\.tasks|TaskSnapshot|listTasks\(|getTask\(|stopTask\(|createTask\(|TodoPanel|SwarmPanel|WorkflowRunsPanel|background tasks" .
```

For every match:

- Rewrite references to the removed public background API/UI as Jobs or `/background`.
- Preserve historical statements explicitly labeled as history.
- Preserve `/schedules/tasks`, `TaskManager`, `SessionTaskRecord`, and model `TaskCreate` where they describe the retained domain/internal implementation.

- [ ] **Step 2: Update the Jobs protocol with the actual phase 1 flow**

Add a public-client/TUI section to `docs/jobs-protocol.md` containing this flow:

```text
POST /background-shells
  -> SessionTaskService.create
  -> TaskManager shell
  -> SessionTaskRecord projection
  -> DaemonJobService.read
  -> { jobId, snapshot }

TUI session activation
  -> GET /jobs?sessionId=...&includeFinished=true&limit=100
  -> JobRemoteState
  -> JobsPanel
```

Document `idle/loading/ready/error`, cached-data-on-error semantics, and that phase 1 refreshes on activation/open/manual refresh/create/control/main-run terminal state.

- [ ] **Step 3: Update convergence status without rewriting history**

In `docs/jobs-task-workflow-convergence.md`, retain the model-tool convergence record and append a dated phase 1 public surface note:

```text
2026-08-20: HTTP client、slash command 与 TUI 已硬切到 Jobs。
后台 shell 由 /background 与 POST /background-shells 创建；创建后统一使用 JobRead/Wait/Send/Cancel。
旧 /tasks、TaskSnapshot 与 TUI session.tasks 已删除，不保留兼容别名。
```

State that `parentJobId` and normalized Job SSE are phase 2, not silently implemented in phase 1.

- [ ] **Step 4: Run formatting and diff checks**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 5: Run the complete verification matrix**

Run:

```bash
pnpm --filter @vykor/jobs test
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test
pnpm --filter @vykor/frontend test
pnpm check-types
pnpm lint
```

Expected:

```text
All Jobs/server/client/frontend tests pass.
All workspace typechecks pass.
Lint passes with no new warning.
```

If a pre-existing unrelated lint/test failure remains, capture its exact command, file, and error; verify the same failure exists without the phase 1 diff before classifying it as pre-existing.

- [ ] **Step 6: Perform the final public-surface audit**

Run:

```bash
rg -n --glob '!docs/**' --glob '!node_modules/**' 'route\("/tasks"|name: "/tasks"|session\.tasks|TaskSnapshot|ListTasksOptions|CreateTaskInput|TodoPanel|SwarmPanel|WorkflowRunsPanel' apps packages
rg -n --glob '!node_modules/**' '/background-shells|createBackgroundShell|jobState|JobsPanel|listJobs\(' apps packages
```

Expected:

- First command: no matches.
- Second command: matches server route, client transport, controller, panel, commands, and tests.
- `rg -n '/schedules/tasks|TaskManager|SessionTaskRecord|TaskCreate' apps packages` still proves retained internal/domain concepts exist.

- [ ] **Step 7: Manually verify the two end-to-end paths**

Start the normal daemon/TUI development flow used by the repository and verify:

```text
Path A:
  /background pnpm --version
  -> receipt contains jobId
  -> /jobs lists shell
  -> Jobs detail reads output
  -> cancel is offered only while capability.cancel is true

Path B:
  start child Agent through Agent producer
  -> /jobs lists agent
  -> Jobs detail reads status/output
  -> a Jobs refresh failure shows an error but does not end the main run

Path C:
  run a Workflow
  -> one workflow Job appears in the top-level list
  -> selecting it shows Steps from JobRead details
  -> no separate Workflow Runs panel exists
```

Record the commands and observed IDs in the implementation handoff; do not commit runtime session data.

- [ ] **Step 8: Commit documentation and verification notes**

```bash
git add docs/jobs-protocol.md docs/jobs-task-workflow-convergence.md README.md docs/slash-commands.md docs/slash-commands-flow.md docs/client-sync-flow.md PLAN-REMAINING.md
git commit -m "docs(jobs): document public surface convergence"
```

## Phase 1 Completion Gate

Phase 1 is complete only when all of the following are true:

1. `TuiSessionController` exposes `jobState`, `jobs`, and `jobDetailState`; it has no `tasks` property.
2. TUI production code never calls `listTasks` and distinguishes Jobs loading, authoritative empty, cached error, and unavailable error.
3. Jobs/MCP/detail errors do not clear or fail the active Agent run.
4. Jobs Panel lists Terminal, shell, Agent, dream, and Workflow Jobs; Workflow Steps appear in selected Workflow detail.
5. `/background` and `POST /background-shells` create a shell and return a Job ID/snapshot.
6. `/jobs` performs list/show/cancel; `/stats`, `/agents`, `/doctor`, and `/dream` use Jobs terminology/data.
7. Public `/tasks`, Task CRUD client methods/types, TodoPanel, SwarmPanel, and the separate WorkflowRunsPanel are gone.
8. `/schedules/tasks`, `TaskManager`, `SessionTaskRecord`, `SessionTaskBridge`, `SessionTaskService`, and model `TaskCreate` remain where required.
9. Focused tests, affected package tests, workspace typecheck, lint, and end-to-end checks pass.
10. A separate phase 2 plan is written before adding `parentJobId` or normalized Job SSE.

## Final-review corrections (2026-08-21)

This section is the current execution gate and supersedes contradictory examples above. The original task text and evidence remain unchanged as historical records.

### Corrected phase boundary

- Phase 1 converges Workflow list/read/cancel into Jobs and renders Workflow Steps from selected `JobReadResult.details`.
- `parentJobId`, stable Workflow child metadata, and folding child Agent Jobs beneath Workflow Jobs remain Phase 2. They are not Phase 1 completion requirements.

### Corrected background-shell failure semantics

The Task 1 catch-all `errorResponse(400, ...)` example is unsafe and no longer authoritative. The final route must:

1. preserve `SessionTaskError.status` for failures before a process is created;
2. make `SessionTaskService.create` failure-safe after manager spawn: store projection, bridge track/sync, or event publication failure must stop the known manager task before the original error escapes; cleanup failure must include the task ID and both errors;
3. return 500 for unexpected create or post-create normalization/read failures;
4. if `create` returned but normalization failed, stop the created task through `SessionTaskService.stop` before returning the error;
5. prove missing-session, injected post-spawn projection failure, and real post-return normalization compensation behavior with focused and server integration tests.

### Added final-review test matrix

- busy/submitted main run survives failed `/jobs cancel`, `/agents`, and `/background`;
- `/stats` and `/doctor` distinguish unavailable Jobs from zero Jobs;
- direct JobsPanel `r` and Hook refresh both cover selected Workflow detail changes;
- deferred cancel/send A → select B → resolve A cannot reclaim B's detail, requests carry AbortSignal, a validated cancel terminal receipt still enters the list, and receipt-less send performs list-only reconciliation;
- control/list snapshot reconciliation cannot regress timestamps or terminal status;
- orphaned UI-only Workflow snapshot/state types are removed while coordinator scheduler and Job detail types remain;
- real long-running manager tasks stop when SessionTaskService post-spawn store/sync projection fails;
- shrinking a Jobs list clamps the stored cursor, not only the rendered cursor.

### Corrected verification gate

The root `package.json` contains `"lint": "turbo lint"`, but `turbo.json` defines no `lint` task and only `apps/desktop` has a package-local ESLint script. Therefore the plan's blanket `pnpm lint` success claim was not a real workspace gate. Do not alter manifests in this fix wave. The current gate is affected/full tests, package and workspace typechecks, repository audits, the dependency-file guard, and `git diff --check`; run the existing desktop ESLint binary only when desktop files are affected.

Accordingly, Phase 1 completion item 9 is read as: focused tests, affected/full package tests, workspace typecheck, audits, dependency guard, and diff check pass. The earlier lint wording is historical and is superseded here.
