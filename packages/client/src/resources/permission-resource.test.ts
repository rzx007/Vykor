import { describe, expect, it } from "vitest";
import { PermissionResource } from "./permission-resource.js";
import type { HttpTransport } from "../transport/http-transport.js";

describe("permission approval management", () => {
  it("lists active grants and sends a revoke to the exact selected request", async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const grant = {
      id: "grant/1",
      sessionId: "s1",
      toolName: "Write",
      payload: {},
      status: "approved",
      decision: "session",
      createdAt: 1,
      updatedAt: 2,
    };
    const resource = new PermissionResource({
      request: async (path: string, options?: { method?: string }) => {
        calls.push({ path, method: options?.method });
        return path.endsWith("/approvals")
          ? { requests: [grant] }
          : { request: { ...grant, status: "denied", decision: "revoked" } };
      },
    } as unknown as HttpTransport);
    expect((await resource.listApprovals())[0]?.id).toBe("grant/1");
    expect((await resource.revokeApproval("grant/1")).decision).toBe("revoked");
    expect(calls).toEqual([
      { path: "/permissions/approvals", method: undefined },
      { path: "/permissions/grant%2F1/revoke", method: "POST" },
    ]);
  });
});
