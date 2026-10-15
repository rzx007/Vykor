import { expect, it, vi } from "vitest";
import { createRunExecutionRoutes, type RunExecutionRoutesContext } from "./run-execution.js";

it.each([undefined, "user", "system"] as const)("forwards an explicit interruption source (%s)", async source => {
  const interruptSession = vi.fn(async () => ({ interrupted: true, queuedRunIds: [] }));
  const app = createRunExecutionRoutes({
    application: { interruptSession } as RunExecutionRoutesContext["application"],
    traces: { get: () => "trace" },
  });
  const response = await app.request("/s/interrupt", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRunId: "r", source }),
  });
  expect(response.status).toBe(200);
  expect(interruptSession).toHaveBeenCalledWith("s", "r", source ?? "user");
});

it("rejects unknown interruption sources before stopping work", async () => {
  const interruptSession = vi.fn();
  const app = createRunExecutionRoutes({
    application: { interruptSession } as RunExecutionRoutesContext["application"],
    traces: { get: () => "trace" },
  });
  expect((await app.request("/s/interrupt", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "unknown" }),
  })).status).toBe(400);
  expect(interruptSession).not.toHaveBeenCalled();
});
