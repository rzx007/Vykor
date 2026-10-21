import { describe, expect, it } from "vitest";
import { createSessionEnvironmentAcquirer } from "./session-execution-environment.js";

describe("createSessionEnvironmentAcquirer", () => {
  it("creates a lightweight local handle without a shared lease", async () => {
    const handle = await createSessionEnvironmentAcquirer()(
      { id: "s1", cwd: process.cwd(), metadata: { runtime: { model: "test" } } } as any,
      {
        model: "test",
        apiFormat: "openai",
        maxTurns: 1,
        permission: { mode: "default" },
        agentEnvironment: { kind: "native" },
        sandbox: { enabled: false },
      },
    );
    expect(handle.info.kind).toBe("local");
    expect(handle.workspace).toEqual({ kind: "local", hostRoot: process.cwd(), executionRoot: process.cwd() });
    expect(handle).not.toHaveProperty("leaseId");
    await expect(handle.release()).resolves.toBeUndefined();
  });
});
