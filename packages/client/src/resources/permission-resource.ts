import type { PermissionRequestRecord } from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";
import type {
  ListPermissionsOptions,
  ReplyPermissionInput,
} from "../types/index.js";

export class PermissionResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /permissions` */
  async list(
    options: ListPermissionsOptions & { signal?: AbortSignal } = {},
  ): Promise<PermissionRequestRecord[]> {
    const { signal, ...query } = options;
    const response = await this.transport.request<{
      requests: PermissionRequestRecord[];
    }>(this.transport.path("/permissions", query), { signal });
    return response.requests;
  }

  /** `POST /permissions/:id/reply` — 批准/拒绝工具权限请求。 */
  async reply(
    requestId: string,
    input: ReplyPermissionInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PermissionRequestRecord> {
    const response = await this.transport.request<{ request: PermissionRequestRecord }>(
      `/permissions/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.request;
  }
}
