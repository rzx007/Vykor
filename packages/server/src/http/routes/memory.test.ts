import { describe, expect, it, vi } from "vitest";
import { createMemoryRoutes } from "./memory.js";
describe("memory editing routes", () => {
  it("uses the cwd mutation barrier and versions before accepting an edit", async () => {
    const update = vi.fn(async (input) => ({
      id: input.id,
      content: input.content,
      createdAt: 1,
      updatedAt: 2,
      revision: "next",
    }));
    const clear = vi.fn(async () => ({ deleted: 1 }));
    const release = vi.fn();
    const barrier = vi.fn(() => ({ release }));
    const close = vi.fn(async () => {});
    const routes = createMemoryRoutes({
      memoryService: { update, clear } as any,
      control: { acquireCwdMutation: barrier, closeRuntimesForCwd: close },
    });
    const request = {
      cwd: "/project",
      content: "Changed memory",
      expectedRevision: "revision",
    };
    expect(
      (
        await routes.request("/mem-id", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(200);
    expect(barrier).toHaveBeenCalledWith("/project");
    expect(update).toHaveBeenCalledWith({ ...request, id: "mem-id" });
    expect(close).toHaveBeenCalledWith("/project");
    expect(release).toHaveBeenCalledTimes(1);
    barrier.mockReturnValueOnce(undefined as any);
    expect(
      (
        await routes.request("/mem-id", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(409);
    expect(update).toHaveBeenCalledTimes(1);
    expect(
      (
        await routes.request("/clear", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cwd: "/project",
            expectedEntries: [{ id: "mem-id", revision: "next" }],
          }),
        })
      ).status,
    ).toBe(200);
    expect(clear).toHaveBeenCalledWith({
      cwd: "/project",
      expectedEntries: [{ id: "mem-id", revision: "next" }],
    });
  });
});
