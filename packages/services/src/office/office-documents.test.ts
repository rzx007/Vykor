import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOfficeRunner,
  hash,
  officeBinaryPath,
} from "./office-engine.mjs";
import {
  readOfficeFile,
  readOfficeBytes,
  MAX_OFFICE_BYTES,
} from "./office-documents.js";
import { sniffOfficePackage } from "./office-package.js";
import { OFFICE_MEDIA_TYPES } from "@vykor/protocol";
import { AttachmentBlobStore } from "../attachments/storage/attachment-blob-store.js";

it("rejects renamed binary and legacy files before invoking the engine", async () => {
  expect(sniffOfficePackage(Buffer.from("not a zip"))).toBeUndefined();
  await expect(
    readOfficeBytes(Buffer.from("fake"), "fake.docx"),
  ).rejects.toThrow("不是有效");
  await expect(readOfficeBytes(Buffer.from("fake"), "old.doc")).rejects.toThrow(
    "仅支持",
  );
});

it("reports size, encryption and damaged Office files before invoking the engine", async () => {
  await expect(
    readOfficeBytes(new Uint8Array(MAX_OFFICE_BYTES + 1), "large.docx"),
  ).rejects.toThrow("超过 64 MB");
  await expect(
    readOfficeBytes(
      Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      "password.docx",
    ),
  ).rejects.toThrow("先解密");
  await expect(
    readOfficeBytes(Buffer.from("PK damaged archive"), "broken.docx"),
  ).rejects.toThrow("损坏");
});

const availableEngine = await officeBinaryPath().catch(() => undefined);
it.skipIf(!availableEngine)(
  "real built-in engine reads and previews all three formats without changing sources",
  async () => {
    const binary = await officeBinaryPath();
    expect(existsSync(binary)).toBe(true);
    const cwd = await mkdtemp(join(tmpdir(), "office-read-test-"));
    const run = await createOfficeRunner({
      cwd,
      signal: new AbortController().signal,
      deadline: Date.now() + 180000,
    });
    try {
      await writeFile(
        join(cwd, "pixel.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      for (const format of ["docx", "xlsx", "pptx"] as const) {
        const file = join(cwd, "sample." + format);
        await run(["create", file]);
        const operations: unknown[] =
          format === "docx"
            ? [
                {
                  command: "add",
                  parent: "/body",
                  type: "paragraph",
                  props: { text: "正文验收 Alpha" },
                },
                {
                  command: "add",
                  parent: "/body",
                  type: "table",
                  props: { data: "工作项,负责人,金额;表格专属,周宁,731" },
                },
                {
                  command: "add",
                  parent: "/body/tbl[1]/tr[2]/tc[2]",
                  type: "paragraph",
                  props: { text: "单元格第二段陈禾" },
                },
                {
                  command: "add",
                  parent: "/body",
                  type: "paragraph",
                  props: { text: "正文结尾 Omega" },
                },
              ]
            : format === "xlsx"
              ? [
                  {
                    command: "set",
                    path: "/Sheet1/A1",
                    props: { value: "表格验收 Alpha" },
                  },
                  {
                    command: "add",
                    parent: "/",
                    type: "sheet",
                    props: { name: "Second" },
                  },
                  {
                    command: "set",
                    path: "/Second/A1",
                    props: { value: "SecondOnly" },
                  },
                ]
              : [
                  {
                    command: "add",
                    parent: "/",
                    type: "slide",
                    props: { title: "第一页 Alpha" },
                  },
                  {
                    command: "add",
                    parent: "/",
                    type: "slide",
                    props: { title: "SecondOnly" },
                  },
                ];
        try {
          if (format === "pptx")
            operations.push({
              command: "add",
              parent: "/slide[1]",
              type: "picture",
              props: {
                src: join(cwd, "pixel.png"),
                x: "1cm",
                y: "4cm",
                width: "1cm",
                height: "1cm",
              },
            });
          await run(["batch", file, "--stop-on-error"], operations);
        } finally {
          await run(["close", file], undefined, true);
        }
        const bytes = await readFile(file),
          before = hash(bytes);
        expect(sniffOfficePackage(bytes)).toBe(OFFICE_MEDIA_TYPES[format]);
        const blobs = new AttachmentBlobStore({ root: join(cwd, "uploads") });
        const stored = await blobs.import({
          uploadId: "test-" + format,
          content: new ReadableStream({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          }),
          declaredMediaType: "application/zip",
          maxBytes: 64 * 1024 * 1024,
        });
        expect(stored.mediaType).toBe(OFFICE_MEDIA_TYPES[format]);
        expect(stored.sha256).toBe(before);
        const parsed = (await readOfficeFile(file)).text;
        expect(parsed).toContain("Alpha");
        if (format === "docx") {
          expect(parsed).toContain("周宁");
          expect(parsed).toContain("731");
          expect(parsed).toContain("单元格第二段陈禾");
          expect(parsed).toContain("/body/tbl[1]/tr[2]/tc[2]/p[");
          expect(parsed).not.toContain("[Table:");
          expect(parsed.indexOf("周宁")).toBeLessThan(
            parsed.indexOf("正文结尾 Omega"),
          );
        }
        const preview = (await readOfficeFile(file, { preview: true }))
          .preview!;
        expect(preview.html).toContain("Alpha");
        if (format === "pptx")
          expect(preview.html).toContain("data:image/png;base64,");
        expect(preview.sha256).toBe(before);
        if (format !== "docx") {
          expect(preview.pageCount).toBe(2);
          const second = (
            await readOfficeFile(file, { preview: true, page: 2 })
          ).preview!;
          expect(second.html).toContain("SecondOnly");
          if (format === "xlsx") {
            expect(second.html).toContain(
              'class="sheet-content active" data-sheet="1"',
            );
            expect(second.html).toContain(
              'class="sheet-content" data-sheet="0"',
            );
          } else expect(second.html).not.toContain("Alpha");
          await expect(
            readOfficeFile(file, { preview: true, page: 3 }),
          ).rejects.toThrow("超出");
        }
        expect(hash(await readFile(file))).toBe(before);
        await expect(
          readOfficeBytes(
            bytes,
            "wrong." + (format === "docx" ? "pptx" : "docx"),
          ),
        ).rejects.toThrow("不是有效");
      }
    } finally {
      await rm(cwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
  180000,
);
