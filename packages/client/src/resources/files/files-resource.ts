import {
  decodeSessionDirectoryResult, decodeSessionFileInfo, decodeSessionTextFileResult,
  decodeSessionFindFilesResult, decodeSessionSearchFilesResult,
} from "@vykor/protocol";
import type {
  SessionDirectoryResult, SessionFileInfo, SessionTextFileResult, SessionFindFilesResult,
  SessionSearchFilesResult, SessionFileListOptions, SessionFileRequestOptions,
  SessionFileReadOptions, SessionFileFindOptions, SessionFileSearchOptions,
} from "../../types/index.js";
import type { HttpTransport } from "../../transport/http-transport.js";

/** Read-only files in the workspace chosen by the session, without starting an Agent. */
export class FilesResource {
  constructor(private readonly transport: HttpTransport) {}

  async list(sessionId: string, options: SessionFileListOptions = {}): Promise<SessionDirectoryResult> {
    const { signal, ...query } = options;
    const response = await this.transport.request<unknown>(
      this.transport.path(`/sessions/${encodeURIComponent(sessionId)}/files`, query), { signal },
    );
    return decodeSessionDirectoryResult(response);
  }

  async stat(sessionId: string, path: string, options: SessionFileRequestOptions = {}): Promise<SessionFileInfo> {
    const response = await this.transport.request<unknown>(
      this.transport.path(`/sessions/${encodeURIComponent(sessionId)}/files/stat`, { path }), { signal: options.signal },
    );
    return decodeSessionFileInfo(response);
  }

  async readText(sessionId: string, path: string, options: SessionFileReadOptions = {}): Promise<SessionTextFileResult> {
    const { signal, ...query } = options;
    const response = await this.transport.request<unknown>(
      this.transport.path(`/sessions/${encodeURIComponent(sessionId)}/files/text`, { path, ...query }), { signal },
    );
    return decodeSessionTextFileResult(response);
  }

  async find(sessionId: string, options: SessionFileFindOptions): Promise<SessionFindFilesResult> {
    const { signal, ...query } = options;
    const response = await this.transport.request<unknown>(
      this.transport.path(`/sessions/${encodeURIComponent(sessionId)}/files/find`, query), { signal },
    );
    return decodeSessionFindFilesResult(response);
  }

  async search(sessionId: string, options: SessionFileSearchOptions): Promise<SessionSearchFilesResult> {
    const { signal, caseSensitive, ...query } = options;
    const response = await this.transport.request<unknown>(
      this.transport.path(`/sessions/${encodeURIComponent(sessionId)}/files/search`, {
        ...query, ...(caseSensitive === undefined ? {} : { caseSensitive: String(caseSensitive) }),
      }), { signal },
    );
    return decodeSessionSearchFilesResult(response);
  }
}
