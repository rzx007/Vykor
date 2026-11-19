import type { HttpTransport } from "@rzx/client";
import type { AttachmentStorageGcResult, AttachmentStorageRepairResult, AttachmentStorageReport } from "../../../shared/attachment-types";

/** 附件存储维护；上传、读取和删除继续使用公开 SDK。 */
export class AttachmentStorageResource {
  constructor(private readonly transport: HttpTransport) {}

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
