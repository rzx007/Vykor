import type { AttachmentAssetRecord } from "@openharness/protocol";
import { parseAttachmentAssetRecord } from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";
import { attachmentRangeHeader } from "../transport/http-transport.js";
import type {
  AttachmentStorageGcResult,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
  DownloadAttachmentOptions,
  UploadAttachmentInput,
} from "../types/index.js";

export class AttachmentResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `POST /attachments` — upload bytes without JSON or multipart buffering. */
  async upload(input: UploadAttachmentInput): Promise<AttachmentAssetRecord> {
    const headers: Record<string, string> = {};
    headers["x-openharness-filename"] = encodeURIComponent(input.displayName);
    if (input.mediaType) headers["content-type"] = input.mediaType;
    const response = await this.transport.requestResponse("/attachments", {
      method: "POST",
      headers,
      body: input.body as RequestInit["body"],
      signal: input.signal,
    });
    return parseAttachmentAssetRecord(await response.json());
  }

  async get(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentAssetRecord> {
    const value = await this.transport.request<unknown>(
      `/attachments/${encodeURIComponent(id)}`,
      { signal: options.signal },
    );
    return parseAttachmentAssetRecord(value);
  }

  /** Returns the raw response so callers can consume the body as a stream. */
  async download(
    id: string,
    options: DownloadAttachmentOptions = {},
  ): Promise<Response> {
    const range = attachmentRangeHeader(options.range);
    const headers: Record<string, string> = {};
    if (range) headers.range = range;
    return await this.transport.requestResponse(
      `/attachments/${encodeURIComponent(id)}/content`,
      { method: "GET", headers, signal: options.signal },
    );
  }

  async delete(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentAssetRecord> {
    const value = await this.transport.request<unknown>(
      `/attachments/${encodeURIComponent(id)}`,
      { method: "DELETE", signal: options.signal },
    );
    return parseAttachmentAssetRecord(value);
  }

  async scanStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageReport> {
    return await this.transport.request<AttachmentStorageReport>(
      "/attachments/storage",
      { signal: options.signal },
    );
  }

  async repairStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageRepairResult> {
    return await this.transport.request<AttachmentStorageRepairResult>(
      "/attachments/storage/actions",
      {
        method: "POST",
        body: { action: "repair-safe" },
        signal: options.signal,
      },
    );
  }

  async gcStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageGcResult> {
    return await this.transport.request<AttachmentStorageGcResult>(
      "/attachments/storage/actions",
      {
        method: "POST",
        body: { action: "gc" },
        signal: options.signal,
      },
    );
  }
}
