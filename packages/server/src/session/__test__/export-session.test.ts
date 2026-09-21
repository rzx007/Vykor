import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeSessionExport } from "../export-session.js";

describe("writeSessionExport", () => {
  it("writes markdown and json exports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-export-"));
    try {
      const session = {
        id: "s1",
        cwd: process.cwd(),
        title: "t",
        model: "m",
        status: "idle" as const,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      };
      const messages = [{
        id: "m1",
        sessionId: "s1",
        seq: 1,
        role: "user" as const,
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }];
      const parts = [{
        id: "p1",
        sessionId: "s1",
        messageId: "m1",
        seq: 1,
        type: "text" as const,
        status: "completed" as const,
        text: "hello export",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }, {
        id: "p2",
        sessionId: "s1",
        messageId: "m1",
        seq: 2,
        type: "attachment" as const,
        status: "completed" as const,
        assetId: "att_1",
        intent: "auto" as const,
        displayName: "screen.png",
        mediaType: "image/png",
        sizeBytes: 42,
        metadata: { inputAttachmentId: "ref_1" },
        createdAt: 1,
        updatedAt: 1,
      }, {
        id: "p3",
        sessionId: "s1",
        messageId: "m1",
        seq: 3,
        type: "reasoning" as const,
        status: "completed" as const,
        text: "internal chain of thought",
        metadata: {},
        createdAt: 1,
        updatedAt: 1,
      }];
      const inputs = [{
        id: "i1",
        sessionId: "s1",
        seq: 1,
        delivery: "queue" as const,
        content: "hello export",
        attachments: [{
          id: "ref_1",
          sessionId: "s1",
          inputId: "i1",
          assetId: "att_1",
          seq: 0,
          intent: "auto" as const,
          displayName: "screen.png",
          mediaType: "image/png",
          sizeBytes: 42,
          metadata: {},
          createdAt: 1,
        }],
        metadata: {},
        createdAt: 1,
      }];

      const md = await writeSessionExport({
        session,
        messages,
        parts,
        inputs,
        format: "md",
        filename: join(dir, "out.md"),
      });
      const markdown = readFileSync(md.filepath, "utf8");
      expect(markdown).toContain("hello export");
      expect(markdown).toContain("[附件: screen.png | image/png | 42 bytes | assetId=att_1]");
      expect(markdown).not.toContain("internal chain of thought");
      expect(markdown).not.toMatch(/storage|blob|sha256/i);

      const json = await writeSessionExport({
        session,
        messages,
        parts,
        inputs,
        format: "json",
        filename: join(dir, "out.json"),
      });
      const parsed = JSON.parse(readFileSync(json.filepath, "utf8")) as {
        message_count: number;
        inputs: typeof inputs;
        messages: Array<{ content: string; parts: typeof parts }>;
      };
      expect(parsed.message_count).toBe(1);
      expect(parsed.messages[0]?.content).toBe("hello export");
      expect(parsed.inputs).toEqual(inputs);
      expect(parsed.messages[0]?.parts).toEqual(parts);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
