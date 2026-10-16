import { describe, expect, it, vi } from "vitest";

import {
  createAttachmentAuthorizationSessionResolver,
  createAttachmentOcrService,
  createAttachmentTextReader,
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

it("checks Office reference ownership before parsing and keeps reads bounded",async()=>{
  const readReadyText=vi.fn(async()=>({displayName:"report.docx",mediaType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",encoding:"utf-8",text:Array(500).fill("x".repeat(2000)).join("\n")}));
  const reader=createAttachmentTextReader({store:{listSessionInputAttachments:(id:string)=>id==="owner"?[{assetId:"office",displayName:"report.docx",mediaType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"} as any]:[]},attachments:{get:()=>({status:"ready"}),readReadyText} as any});
  await expect(reader.readText({authorizationSessionId:"other",assetId:"office",offset:1,limit:2000})).rejects.toThrow("access_denied");
  expect(readReadyText).not.toHaveBeenCalled();
  const result=await reader.readText({authorizationSessionId:"owner",assetId:"office",offset:1,limit:2000});
  expect(result.content.length).toBeLessThan(50000);expect(result.hasMore).toBe(true);
});

it("allows every part of a long Office paragraph to be read across pages", async () => {
  const text = "甲😀".repeat(20000) + "TAIL_MARK";
  const reader = createAttachmentTextReader({
    store: { listSessionInputAttachments: () => [{ assetId: "office", displayName: "report.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } as any] },
    attachments: { get: () => ({ status: "ready" }), readReadyText: async () => ({ displayName: "report.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", encoding: "utf-8", text }) } as any,
  });
  let offset = 1;
  let recovered = "";
  for (let page = 0; page < 100; page++) {
    const slice = await reader.readText({ authorizationSessionId: "owner", assetId: "office", offset, limit: 2000 });
    expect(Buffer.byteLength(slice.content, "utf8")).toBeLessThanOrEqual(48000);
    expect(slice.endLine).toBeGreaterThanOrEqual(offset);
    recovered += slice.content.replaceAll("\n", "");
    if (!slice.hasMore) break;
    offset = slice.endLine + 1;
  }
  expect(recovered).toBe(text);
});
