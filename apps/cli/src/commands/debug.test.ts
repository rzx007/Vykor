import { afterEach, describe, expect, it, vi } from "vitest";

import { printProjectionSettlements, printRunInspection, requestDebug } from "./debug.js";

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
          return Response.json({ serverVersion: "test", protocol: { version: 4 }, features: {} });
        }
        expect(new URL(String(url)).searchParams.get("includeContent")).toBe("true");
        return headers.get("x-vykor-protocol-version") === "4"
          ? Response.json({ diagnosticOk: true })
          : Response.json({ error: "protocol_version_mismatch" }, { status: 426 });
      });

      await expect(requestDebug(path, options)).resolves.toEqual({ diagnosticOk: true });
      expect(calls.map((call) => call.path)).toEqual(["/capabilities", path]);
      expect(calls[0]!.headers.has("authorization")).toBe(false);
      expect(calls[1]!.headers.get("authorization")).toBe("Bearer secret");
      expect(calls[1]!.headers.get("x-vykor-protocol-version")).toBe("4");
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
