import type {
  CreateNoteInput,
  NoteRecord,
  UpdateNoteInput,
} from "@vykor/protocol";

import type { HttpTransport } from "../transport/http-transport.js";

export class NoteResource {
  constructor(private readonly transport: HttpTransport) {}

  storageInfo(): Promise<{ directory: string; format: "markdown" }> {
    return this.transport.request("/notes/storage");
  }

  async list(options: { signal?: AbortSignal } = {}): Promise<NoteRecord[]> {
    const response = await this.transport.request<{ notes: NoteRecord[] }>(
      "/notes",
      {
        signal: options.signal,
      },
    );
    return response.notes;
  }

  async create(
    input: CreateNoteInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<NoteRecord> {
    const response = await this.transport.request<{ note: NoteRecord }>(
      "/notes",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return response.note;
  }

  async update(
    id: string,
    input: UpdateNoteInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<NoteRecord> {
    const response = await this.transport.request<{ note: NoteRecord }>(
      `/notes/${encodeURIComponent(id)}`,
      { method: "PATCH", body: input, signal: options.signal },
    );
    return response.note;
  }

  async remove(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.transport.request<{ removed: true }>(
      `/notes/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        signal: options.signal,
      },
    );
  }
}
