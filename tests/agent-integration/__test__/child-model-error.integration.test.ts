import { expect, it } from "vitest";
import { createLifecycleFixture } from "./fixtures/task-lifecycle-fixture.js";

it.each(["sdk", "daemon"] as const)("returns model_error to the parent and through Jobs after a child model request fails: %s", async mode => {
  const f = await createLifecycleFixture(mode, { failure: { label: "model-failure", kind: "failed" } });
  try {
    const child = await f.spawn("model-failure");
    const waited = await f.wait(child.target);
    expect(waited.snapshot).toMatchObject({ status: "failed", metadata: { childFailure: { failureKind: "model_error" } } });
    expect(waited.text).toContain("failure:model-failure");
    await f.waitForRoot();
    const reports = f.agent.getHistory().flatMap(message => {
      if (message.type !== "user" || typeof message.content !== "string" || !message.content.startsWith("<subagent_results>")) return [];
      return JSON.parse(message.content.split("\n")[1]!) as Array<Record<string, unknown>>;
    });
    expect(reports).toContainEqual(expect.objectContaining({
      status: "failed", failureKind: "model_error", error: "failure:model-failure",
    }));
  } finally { await f.close(); }
});
