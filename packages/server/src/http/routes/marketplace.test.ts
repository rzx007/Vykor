import { expect, it } from "vitest";
import { createMarketplaceRoutes } from "./marketplace.js";
it("validates install input before reaching the service", async () => {
  let called = false;
  const app = createMarketplaceRoutes({
    install: async () => {
      called = true;
      throw new Error("must not run");
    },
  } as never);
  const response = await app.request("/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd: "project",
      candidateId: "candidate",
      operationId: "operation",
      approvedPermissions: [42],
    }),
  });
  expect(response.status).toBe(400);
  expect(called).toBe(false);
});
it("serves an install receipt without invoking lifecycle or runtime reload hooks", async () => {
  const receipt = {
    operationId: "operation-one",
    status: "installed",
    message: "已安装",
  };
  const app = createMarketplaceRoutes({
    install: async () => receipt,
    operation: async () => receipt,
  } as never);
  const response = await app.request("/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd: "project",
      candidateId: "candidate",
      operationId: "operation-one",
      approvedPermissions: [],
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(receipt);
  expect(await (await app.request("/operations/operation-one")).json()).toEqual(
    receipt,
  );
});
