import { describe, expect, it } from "vitest";
import { ProtocolValidationError, parseMarketplaceCatalogRequest, parseMarketplaceAddSourceRequest,
  parseMarketplaceSourceEnabledRequest, parseMarketplacePreviewRequest, parseMarketplaceCancelRequest,
  parseMarketplaceInstallRequest } from "../../index.js";

const selection = { cwd: "/work", sourceId: "source", pluginId: "plugin", version: "1.0.0" };
const install = { cwd: "/work", candidateId: "candidate", operationId: "operation", approvedPermissions: ["fs:read"] };
describe("marketplace wire requests", () => {
  it("preserves selections, approvals and optional replacement consent", () => {
    expect(parseMarketplacePreviewRequest(selection)).toEqual(selection);
    expect(parseMarketplaceInstallRequest(install)).toEqual(install);
    expect(parseMarketplaceInstallRequest({ ...install, allowSourceChange: false })).toEqual({ ...install, allowSourceChange: false });
    expect(parseMarketplaceAddSourceRequest({ url: "https://example.com/catalog.json" })).toEqual({ url: "https://example.com/catalog.json" });
    expect(parseMarketplaceSourceEnabledRequest({ enabled: false })).toEqual({ enabled: false });
    expect(parseMarketplaceCancelRequest({ candidateId: "candidate" })).toEqual({ candidateId: "candidate" });
  });
  it.each([[undefined, undefined], ["true", true], ["false", false], [false, false]])("parses refresh %s", (refresh, expected) => {
    expect(parseMarketplaceCatalogRequest({ cwd: "/work", refresh })).toEqual({ cwd: "/work", ...(expected === undefined ? {} : { refresh: expected }) });
  });
  it.each([
    () => parseMarketplacePreviewRequest({ ...selection, granted: true }),
    () => parseMarketplacePreviewRequest({ ...selection, cwd: " " }),
    () => parseMarketplacePreviewRequest({ ...selection, pluginId: "x".repeat(4097) }),
    () => parseMarketplaceInstallRequest({ ...install, approvedPermissions: [42] }),
    () => parseMarketplaceInstallRequest({ ...install, approvedPermissions: Array(257).fill("read") }),
    () => parseMarketplaceInstallRequest({ ...install, allowSourceChange: "yes" }),
    () => parseMarketplaceCatalogRequest({ cwd: "/work", refresh: "yes" }),
    () => parseMarketplaceSourceEnabledRequest({ enabled: 1 }),
    () => parseMarketplaceCancelRequest(null),
    () => parseMarketplaceAddSourceRequest({ url: "https://example.com", granted: true }),
  ])("rejects malformed or unknown transport fields", parse => {
    expect(parse).toThrow(ProtocolValidationError);
  });
});
