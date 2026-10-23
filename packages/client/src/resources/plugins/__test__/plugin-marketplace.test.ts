import { describe, expect, it, vi } from "vitest";
import { PluginResource } from "../plugin-resource.js";
describe("marketplace transport", () => {
  it("keeps source identities encoded and installation operation stable", async () => {
    const request = vi.fn().mockResolvedValue({});
    const plugins = new PluginResource({ request, path: (p: string) => p } as never);
    await plugins.marketplaceSetSourceEnabled("a/b", { enabled: false });
    expect(request).toHaveBeenCalledWith("/plugins/marketplace/sources/a%2Fb", expect.objectContaining({ method: "PATCH", body: { enabled: false } }));
    const input = { cwd: "/work", candidateId: "candidate", operationId: "original", approvedPermissions: [] };
    await plugins.marketplaceInstall(input);
    expect(request).toHaveBeenLastCalledWith("/plugins/marketplace/install", expect.objectContaining({ body: input }));
  });
});
