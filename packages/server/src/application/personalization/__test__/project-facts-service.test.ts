import { describe, expect, it, vi } from "vitest";
import { createProjectFactsService } from "../project-facts-service.js";
describe("Project facts application use cases", () => {
  it("checks readiness before acquiring a cwd mutation lease", async () => {
    const acquireCwdMutation = vi.fn();
    const service = createProjectFactsService({
      control: { acquireCwdMutation, closeRuntimesForCwd: vi.fn() },
      sessions: { get: vi.fn() },
      readiness: () => ({ phase: "closing", accepting: false }),
    });
    await expect(
      service.replace({ cwd: "/repo", oldKey: "key", newValue: "value" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(acquireCwdMutation).not.toHaveBeenCalled();
  });
});
