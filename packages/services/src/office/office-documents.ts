import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  officeFormat,
  OFFICE_MEDIA_TYPES,
  type OfficePreview,
} from "@vykor/protocol";
import { createOfficeRunner, hash } from "./office-engine.mjs";
import { sniffOfficePackage } from "../attachments/storage/attachment-media-type.js";
import { wordParagraphText, assertCompleteOfficeText } from "./office-text.js";

export const MAX_OFFICE_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, string>();
let cachedChars = 0;
function remember(key: string, value: string): void {
  if (value.length > 8_000_000) return;
  const previous = cache.get(key);
  if (previous) cachedChars -= previous.length;
  cache.delete(key);
  cache.set(key, value);
  cachedChars += value.length;
  while (cache.size > 16 || cachedChars > 16_000_000) {
    const first = cache.keys().next().value!;
    cachedChars -= cache.get(first)!.length;
    cache.delete(first);
  }
}

export async function readOfficeBytes(
  bytes: Uint8Array,
  name: string,
  options: { page?: number; preview?: boolean; signal?: AbortSignal } = {},
): Promise<{ text: string; preview?: OfficePreview }> {
  options.signal?.throwIfAborted();
  const format = officeFormat(name);
  if (!format) throw new Error("仅支持 DOCX、XLSX、PPTX 文件。");
  if (bytes.byteLength > MAX_OFFICE_BYTES)
    throw new Error("Office 文件超过 64 MB，请拆分文档后重试。");
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    )
  ) {
    throw new Error(
      "该文件可能已加密或使用旧版 Office 格式；请先解密并另存为 DOCX、XLSX 或 PPTX 后上传。",
    );
  }
  if (sniffOfficePackage(bytes) !== OFFICE_MEDIA_TYPES[format])
    throw new Error(
      "不是有效的 Office 文件：文件可能损坏、内容与扩展名不符，或含不支持的加密和宏。",
    );
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 200)
    throw new Error("预览页须为 1–200 的整数。");
  const digest = hash(bytes),
    key = `${digest}:${format}:${options.preview ? "html:" + page : "text"}`;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit) as { text: string; preview?: OfficePreview };
  const directory = await mkdtemp(join(tmpdir(), "vykor-office-"));
  const file = join(directory, `document.${format}`),
    htmlFile = join(directory, "preview.html");
  let failure: unknown;
  let result: { text: string; preview?: OfficePreview };
  let runner: Awaited<ReturnType<typeof createOfficeRunner>> | undefined;
  try {
    await writeFile(file, bytes);
    runner = await createOfficeRunner({
      cwd: directory,
      signal: options.signal ?? new AbortController().signal,
      deadline: Date.now() + 55000,
      maxOutputBytes: 4_000_000,
    });
    if (options.preview) {
      const structure = JSON.parse(
        await runner(["get", file, "/", "--json"]),
      ) as { data?: { results?: Array<{ childCount?: number }> } };
      const pageCount =
        format === "docx" ? 1 : structure.data?.results?.[0]?.childCount;
      if (pageCount !== undefined && page > pageCount)
        throw new Error("预览页超出文档范围。");
      await runner([
        "view",
        file,
        "html",
        "-o",
        htmlFile,
        ...(format === "docx" ? [] : ["--page", String(page)]),
      ]);
      if ((await stat(htmlFile)).size > 8_000_000)
        throw new Error("预览内容过大，请缩小范围。");
      let html = await readFile(htmlFile, "utf8");
      // OfficeCLI exports every workbook sheet; select it statically because preview scripts are disabled.
      if (format === "xlsx")
        html = html.replace(
          /<div class="sheet-content(?: active)?" data-sheet="(\d+)">/g,
          (_, index: string) =>
            `<div class="sheet-content${Number(index) === page - 1 ? " active" : ""}" data-sheet="${index}">`,
        );
      result = {
        text: "",
        preview: {
          html,
          format,
          page,
          ...(pageCount === undefined ? {} : { pageCount }),
          sha256: digest,
        },
      };
    } else {
      result = {
        text:
          format === "docx"
            ? wordParagraphText(
                await runner(["query", file, "paragraph", "--json"]),
              )
            : assertCompleteOfficeText(
                await runner(["view", file, "text", "--max-lines", "100000"]),
              ),
      };
    }
    options.signal?.throwIfAborted();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (runner) {
      try {
        await runner(["close", file], undefined, true);
      } catch {
        try {
          await runner(["close", file], undefined, true);
        } catch (error) {
          throw new Error(
            `${failure instanceof Error ? failure.message + "; " : ""}Office 工作副本未关闭，保留于 ${directory}：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  remember(key, JSON.stringify(result!));
  return result!;
}

export async function readOfficeFile(
  file: string,
  options: {
    page?: number;
    preview?: boolean;
    signal?: AbortSignal;
    formatName?: string;
  } = {},
) {
  if ((await stat(file)).size > MAX_OFFICE_BYTES)
    throw new Error("Office 文件超过 64 MB。");
  return await readOfficeBytes(
    await readFile(file),
    options.formatName ?? file,
    options,
  );
}
