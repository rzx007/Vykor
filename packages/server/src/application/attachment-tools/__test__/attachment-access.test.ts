import { describe, expect, it, vi } from "vitest";

import {
  createAttachmentAuthorizationSessionResolver,
  createAttachmentOcrService,
} from "../attachment-access.js";

describe("attachment authorization", () => {
  it("uses roots directly and only resolves children through the live directory", () => {
    const sessions = new Map([
      ["root", { id: "root" }],
      ["child", { id: "child", parentId: "root" }],
      ["nested", { id: "nested", parentId: "child" }],
      ["closed", { id: "closed", parentId: "root" }],
    ]);
    const resolver = createAttachmentAuthorizationSessionResolver({
      store: { getSession: (id: string) => sessions.get(id) as any },
      liveChildren: {
        resolveRootSessionId: (id: string) =>
          id === "child" || id === "nested" ? "root" : undefined,
      },
    });

    expect(resolver.resolve("root")).toBe("root");
    expect(resolver.resolve("child")).toBe("root");
    expect(resolver.resolve("nested")).toBe("root");
    expect(resolver.resolve("closed")).toBeUndefined();
    expect(resolver.resolve("missing")).toBeUndefined();
  });

  it("checks the root input reference before invoking OCR", async () => {
    const recognize = vi.fn(async () => ({ status: "completed" as const, text: "ok" }));
    const service = createAttachmentOcrService({
      store: {
        listSessionInputAttachments: (sessionId: string) =>
          sessionId === "root" ? [{ assetId: "allowed" } as any] : [],
      },
      recognize,
    });

    await expect(service.recognize({
      authorizationSessionId: "root",
      assetId: "allowed",
    })).resolves.toMatchObject({ text: "ok" });
    await expect(service.recognize({
      authorizationSessionId: "other",
      assetId: "allowed",
    })).rejects.toThrow("attachment_resource_access_denied");
    expect(recognize).toHaveBeenCalledTimes(1);
  });
});
