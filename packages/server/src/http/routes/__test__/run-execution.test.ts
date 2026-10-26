import { expect, it, vi } from "vitest";
import { createRunExecutionRoutes, type RunExecutionRoutesContext } from "../run-execution.js";

it.each(["edit", "resume"])("forwards explicit schema through %s and rejects hidden or malformed schemas", async action => {
  const outputSchema = { type: "string" };
  const mutation = vi.fn(async (_session: string, ...args: unknown[]) => ({ accepted: args.at(-1) }));
  const app = createRunExecutionRoutes({
    application: { editLatestPrompt: mutation, resumeRun: mutation } as RunExecutionRoutesContext["application"],
    traces: { get: () => "trace" },
  });
  const url = action === "edit" ? "/s/prompts/latest/edit" : "/s/runs/r/resume";
  const body = action === "edit" ? { id: "i", sourceMessageId: "m", content: "report" } : {};
  const request = (constraint: unknown) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...constraint as object }) });
  const response = await request({ outputSchema });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: { outputSchema } });
  for (const constraint of [{ outputSchema: [] }, { metadata: { outputSchema } }, { runMetadata: { outputSchema } }]) {
    expect((await request(constraint)).status).toBe(400);
  }
  expect(mutation).toHaveBeenCalledTimes(1);
});

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
