import { expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { JobReadResult, JobSnapshot } from "@vykor/client";
import { ThemeProvider } from "../theme/ThemeContext";
import type { JobDetailRemoteState, JobRemoteState } from "../jobs/job-remote-state";
import { JobsPanel } from "./JobsPanel";

const baseJob: JobSnapshot = {
  id: "agent-1",
  kind: "agent",
  label: "Review the change",
  ownerSession: "session-1",
  status: "running",
  capabilities: { read: true, wait: true, send: true, cancel: true },
  cwd: "/repo",
  startedAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
};

function job(overrides: Partial<JobSnapshot>): JobSnapshot {
  return { ...baseJob, ...overrides, capabilities: { ...baseJob.capabilities, ...overrides.capabilities } };
}

function detail(snapshot: JobSnapshot, overrides: Partial<JobReadResult> = {}): JobReadResult {
  return {
    snapshot,
    text: "first output line\nsecond output line\nthird output line",
    cursor: 48,
    truncated: false,
    ...overrides,
  };
}

async function renderPanel(
  state: JobRemoteState,
  detailState: JobDetailRemoteState = { status: "idle" },
  callbacks: Partial<{
    onRefresh(): void;
    onSelect(jobId: string): void;
    onCancel(jobId: string): void;
  }> = {},
) {
  return await testRender(
    <ThemeProvider>
      <JobsPanel
        state={state}
        detailState={detailState}
        onRefresh={callbacks.onRefresh ?? (() => {})}
        onSelect={callbacks.onSelect ?? (() => {})}
        onCancel={callbacks.onCancel ?? (() => {})}
      />
    </ThemeProvider>,
    { width: 88, height: 36 },
  );
}

test("JobsPanel renders each list remote state without conflating cached data and an authoritative empty result", async () => {
  const cases: Array<{ state: JobRemoteState; expected: string }> = [
    { state: { status: "loading", jobs: [] }, expected: "Loading Jobs" },
    { state: { status: "ready", jobs: [], refreshedAt: 10 }, expected: "No Jobs in this session" },
    { state: { status: "error", jobs: [], error: "offline" }, expected: "Jobs unavailable: offline" },
    { state: { status: "error", jobs: [baseJob], error: "offline" }, expected: "Showing cached Jobs" },
  ];

  for (const { state, expected } of cases) {
    const { renderer, renderOnce, captureCharFrame } = await renderPanel(state);
    try {
      await act(async () => { await renderOnce(); });
      expect(captureCharFrame()).toContain(expected);
    } finally {
      await act(async () => { renderer.destroy(); });
    }
  }
});

test("JobsPanel renders every job kind and distinguishes a running job from finished markers", async () => {
  const jobs = [
    job({ id: "workflow-1", kind: "workflow", label: "workflow", status: "running" }),
    job({ id: "terminal-1", kind: "terminal", label: "terminal", status: "completed" }),
    job({ id: "shell-1", kind: "shell", label: "shell", status: "killed" }),
    job({ id: "agent-1", kind: "agent", label: "agent", status: "failed" }),
    job({ id: "dream-1", kind: "dream", label: "dream", status: "running" }),
  ];
  const { renderer, renderOnce, captureCharFrame } = await renderPanel({ status: "ready", jobs, refreshedAt: 10 });

  try {
    await act(async () => { await renderOnce(); });
    const frame = captureCharFrame();
    for (const expected of ["workflow", "terminal", "shell", "agent", "dream", "running", "completed", "killed", "failed"]) {
      expect(frame).toContain(expected);
    }
    expect(frame).toContain("● workflow");
    expect(frame).toContain("✓ terminal");
    expect(frame).toContain("■ shell");
    expect(frame).toContain("✗ agent");
  } finally {
    await act(async () => { renderer.destroy(); });
  }
});

test("JobsPanel selects the navigated job and only cancels snapshots with cancel capability", async () => {
  const selected: string[] = [];
  const cancelled: string[] = [];
  const jobs = [
    job({ id: "agent-1", kind: "agent", label: "agent", capabilities: { read: true, wait: true, send: true, cancel: false } }),
    job({ id: "shell-1", kind: "shell", label: "shell", capabilities: { read: true, wait: true, send: true, cancel: true } }),
  ];
  const { renderer, renderOnce, mockInput } = await renderPanel(
    { status: "ready", jobs, refreshedAt: 10 },
    { status: "idle" },
    { onSelect: (id) => selected.push(id), onCancel: (id) => cancelled.push(id) },
  );

  try {
    await act(async () => { await renderOnce(); });
    await act(async () => {
      mockInput.pressArrow("down");
    });
    await act(async () => {
      mockInput.pressKey("RETURN");
    });
    expect(selected).toEqual(["shell-1"]);

    await act(async () => {
      mockInput.pressKey("c");
    });
    expect(cancelled).toEqual(["shell-1"]);

    await act(async () => {
      mockInput.pressArrow("up");
    });
    await act(async () => {
      mockInput.pressKey("c");
    });
    expect(cancelled).toEqual(["shell-1"]);
  } finally {
    await act(async () => { renderer.destroy(); });
  }
});

test("JobsPanel maps the r key directly to refresh", async () => {
  let refreshes = 0;
  const { renderer, renderOnce, mockInput } = await renderPanel(
    { status: "ready", jobs: [baseJob], refreshedAt: 10 },
    { status: "idle" },
    { onRefresh: () => { refreshes += 1; } },
  );

  try {
    await act(async () => { await renderOnce(); });
    await act(async () => { mockInput.pressKey("r"); });
    expect(refreshes).toBe(1);
  } finally {
    await act(async () => { renderer.destroy(); });
  }
});

test("JobsPanel clamps its stored cursor when a filtered list shrinks", async () => {
  const initialJobs = Array.from({ length: 5 }, (_, index) => job({
    id: `agent-${index + 1}`,
    label: `Agent ${index + 1}`,
  }));
  const selected: string[] = [];
  let shrink = () => {};
  function Harness() {
    const [jobs, setJobs] = useState(initialJobs);
    shrink = () => setJobs(initialJobs.slice(0, 2));
    return (
      <ThemeProvider>
        <JobsPanel
          state={{ status: "ready", jobs, refreshedAt: 10 }}
          detailState={{ status: "idle" }}
          onRefresh={() => {}}
          onSelect={(jobId) => selected.push(jobId)}
          onCancel={() => {}}
        />
      </ThemeProvider>
    );
  }

  const { renderer, renderOnce, mockInput } = await testRender(<Harness />, { width: 88, height: 36 });
  try {
    await act(async () => { await renderOnce(); });
    await act(async () => {
      for (let index = 0; index < 4; index += 1) mockInput.pressArrow("down");
    });
    await act(async () => {
      shrink();
      await renderOnce();
    });
    await act(async () => { mockInput.pressArrow("up"); });
    await act(async () => { mockInput.pressKey("RETURN"); });

    expect(selected).toEqual(["agent-1"]);
  } finally {
    await act(async () => { renderer.destroy(); });
  }
});

test("JobsPanel renders generic detail output, cached detail errors, and defensively bounded workflow steps", async () => {
  const workflow = job({ id: "workflow-1", kind: "workflow", label: "Nightly workflow" });
  const result = detail(workflow, {
    details: {
      plan: {
        tasks: [
          { taskId: "research", status: "completed", summary: "Collected sources" },
          { taskId: "draft", status: "running", summary: "Writing draft" },
          { taskId: "publish", status: "pending" },
          { taskId: "review", status: "pending" },
          { taskId: "notify", status: "pending" },
          { taskId: "archive", status: "pending" },
          { taskId: 42, status: "bad" },
          { status: "missing-id" },
        ],
      },
      reconciliation: { summary: "1 task needs reconciliation" },
    },
  });
  const { renderer, renderOnce, captureCharFrame } = await renderPanel(
    { status: "ready", jobs: [workflow], refreshedAt: 10 },
    { status: "ready", jobId: workflow.id, result, refreshedAt: 11 },
  );

  try {
    await act(async () => { await renderOnce(); });
    const frame = captureCharFrame();
    for (const expected of [
      "DETAIL",
      "workflow running Nightly workflow",
      "id: workflow-1",
      "cwd: /repo",
      "started: 2023-11-14T22:13:20.000Z",
      "third output line",
      "STEPS",
      "research completed Collected sources",
      "draft running Writing draft",
      "+1 steps",
      "1 task needs reconciliation",
    ]) {
      expect(frame).toContain(expected);
    }
    expect(frame).not.toContain("unknown");
  } finally {
    await act(async () => { renderer.destroy(); });
  }

  const cached = detail(baseJob, { text: "cached output" });
  const errorRender = await renderPanel(
    { status: "ready", jobs: [baseJob], refreshedAt: 10 },
    { status: "error", jobId: baseJob.id, error: "offline", previous: cached },
  );
  try {
    await act(async () => { await errorRender.renderOnce(); });
    expect(errorRender.captureCharFrame()).toContain("Detail unavailable: offline");
    expect(errorRender.captureCharFrame()).toContain("cached output");
  } finally {
    await act(async () => { errorRender.renderer.destroy(); });
  }
});
