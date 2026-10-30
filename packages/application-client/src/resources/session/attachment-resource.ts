import { AttachmentResource as CoreAttachmentResource, type HttpTransport } from "@rzx/client";
import type { AttachmentStorageGcResult, AttachmentStorageRepairResult, AttachmentStorageReport } from "../../types/index.js";

/** 附件存储维护；上传、读取和删除继续使用公开 SDK。 */
export class AttachmentResource extends CoreAttachmentResource {
  constructor(private readonly appTransport: HttpTransport) { super(appTransport); }

  async scanStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageReport> {
    return await this.appTransport.request<AttachmentStorageReport>(
      "/attachments/storage",
      { signal: options.signal },
    );
  }

  async repairStorage(
    options: { signal?: AbortSignal } = {},
  ): Promise<AttachmentStorageRepairResult> {
    return await this.appTransport.request<AttachmentStorageRepairResult>(
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
    return await this.appTransport.request<AttachmentStorageGcResult>(
      "/attachments/storage/actions",
      {
        method: "POST",
        body: { action: "gc" },
        signal: options.signal,
      },
    );
  }
}
