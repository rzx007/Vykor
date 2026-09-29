import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/client";

import { printProjectionSettlements, printRunInspection, requestDebug, printExecutionObservations } from "./debug.js";

describe("debug protocol handshake", () => {
  afterEach(() => vi.restoreAllMocks());

  const options = { daemonUrl: "http://daemon.test/", daemonToken: "secret", includeContent: true };

  it.each(["/debug/runs/run-1", "/debug/projection-settlements"])(
    "verifies capabilities before requesting %s with the current version",
    async (path) => {
      const calls: Array<{ path: string; headers: Headers }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const requestPath = new URL(String(url)).pathname;
        const headers = new Headers(init?.headers);
        calls.push({ path: requestPath, headers });
        if (requestPath === "/capabilities") {
          return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
        }
        expect(new URL(String(url)).searchParams.get("includeContent")).toBe("true");
        return headers.get("x-vykor-protocol-version") === String(CURRENT_PROTOCOL_VERSION)
          ? Response.json({ diagnosticOk: true })
          : Response.json({ error: "protocol_version_mismatch" }, { status: 426 });
      });

      await expect(requestDebug(path, options)).resolves.toEqual({ diagnosticOk: true });
      expect(calls.map((call) => call.path)).toEqual(["/capabilities", path]);
      expect(calls[0]!.headers.has("authorization")).toBe(false);
      expect(calls[1]!.headers.get("authorization")).toBe("Bearer secret");
      expect(calls[1]!.headers.get("x-vykor-protocol-version")).toBe(String(CURRENT_PROTOCOL_VERSION));
    },
  );

  it.each(["/debug/runs/run-1", "/debug/projection-settlements"])(
    "does not request %s when the handshake rejects an old server",
    async (path) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ serverVersion: "old", protocol: { version: 3 }, features: {} }),
      );
      await expect(requestDebug(path, options)).rejects.toMatchObject({ name: "IncompatibleProtocolError" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]![0])).toBe("http://daemon.test/capabilities");
    },
  );
});

function kindSummary(input: {
  completed?: number;
  failed?: number;
  timedOut?: number;
  cancelled?: number;
  blocked?: number;
  skipped?: number;
  unknown?: number;
}): Record<string, number> {
  const completed = input.completed ?? 0;
  const failed = input.failed ?? 0;
  const timedOut = input.timedOut ?? 0;
  const cancelled = input.cancelled ?? 0;
  const blocked = input.blocked ?? 0;
  const skipped = input.skipped ?? 0;
  const unknown = input.unknown ?? 0;
  return {
    total: completed + failed + timedOut + cancelled + blocked + skipped + unknown,
    completed,
    failed,
    timedOut,
    cancelled,
    blocked,
    skipped,
    unknown,
  };
}

describe("debug executions", () => {
  afterEach(() => vi.restoreAllMocks());

  const options = { daemonUrl: "http://daemon.test/", daemonToken: "secret" };

  it("maps CLI query options onto the executions request", async () => {
    let requestUrl: URL | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/capabilities") {
        return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
      }
      expect(new Headers(init?.headers).get("x-vykor-protocol-version")).toBe(String(CURRENT_PROTOCOL_VERSION));
      requestUrl = parsed;
      return Response.json({ schemaVersion: 1, generatedAt: 1, filters: {}, summary: {}, records: [], warnings: [] });
    });

    await requestDebug("/debug/executions", options, {
      kind: "child_agent_run,workflow_task",
      outcome: "failed,timed_out",
      sessionId: "s1",
      from: "100",
      to: "200",
      reviewStatus: "findings,passed",
      reviewRisk: "high,medium",
    });

    expect(requestUrl?.searchParams.get("kind")).toBe("child_agent_run,workflow_task");
    expect(requestUrl?.searchParams.get("outcome")).toBe("failed,timed_out");
    expect(requestUrl?.searchParams.get("sessionId")).toBe("s1");
    expect(requestUrl?.searchParams.get("from")).toBe("100");
    expect(requestUrl?.searchParams.get("to")).toBe("200");
    expect(requestUrl?.searchParams.get("reviewStatus")).toBe("findings,passed");
    expect(requestUrl?.searchParams.get("reviewRisk")).toBe("high,medium");
  });

  it("prints the versioned JSON report verbatim", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const report = { schemaVersion: 1, generatedAt: 1, filters: {}, summary: {}, records: [], warnings: [] };
    printExecutionObservations(report, true);
    expect(log).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
  });

  it("prints a content-free human summary", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printExecutionObservations({
      schemaVersion: 1,
      generatedAt: 1,
      filters: {},
      summary: {
        child_agent_run: { ...kindSummary({ completed: 1, failed: 1 }), reviews: { findings: 1, passed: 2 } },
        workflow_task: kindSummary({ completed: 1, timedOut: 1 }),
      },
      records: [
        { executionId: "a", body: "prompt secret" },
        { executionId: "b" },
        { executionId: "c" },
        { executionId: "d" },
      ],
      warnings: [{ code: "invalid_workflow_event", sourceId: "wf-1:event:2" }],
    }, false);

    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Execution observations: 4 records, 1 warning");
    expect(output).toContain("child_agent_run: completed=1 failed=1 timed_out=0 cancelled=0 skipped=0 reviews=findings:1,passed:2");
    expect(output).toContain("workflow_task: completed=1 failed=0 timed_out=1 cancelled=0 skipped=0");
    expect(output).not.toContain("workflow_task: completed=1 failed=0 timed_out=1 cancelled=0 skipped=0 reviews=");
    expect(output).toContain("[invalid_workflow_event] wf-1:event:2");
    expect(output).not.toContain("prompt secret");
  });
});

describe("debug command formatters", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints a compact human run diagnosis", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printRunInspection({
      runId: "r1",
      run: { sessionId: "s1", inputId: "i1", status: "failed" },
      attempts: [{}], toolCalls: [{}, {}], permissions: [], childExecutions: [], events: [{}],
      warnings: [{ code: "unknown_tool_outcome", message: "may have executed" }],
    }, false);
    expect(log).toHaveBeenCalledWith("Run: r1  status=failed");
    expect(log).toHaveBeenCalledWith("- [unknown_tool_outcome] may have executed");
  });

  it("shows pending projection work without printing payloads", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printProjectionSettlements({ settlements: [{ id: "s1", status: "pending", projector: "agent", action: "retry-terminal-projection", attemptCount: 2 }], pending: 1 }, false);
    expect(log).toHaveBeenCalledWith("Projection settlements: 1  pending/retrying: 1");
  });
});
