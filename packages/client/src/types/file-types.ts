import type { SessionFileFindInput, SessionFileListInput, SessionFileReadInput, SessionFileSearchInput } from "@vykor/protocol";

export type {
  SessionFileInfo, SessionDirectoryResult, SessionTextFileResult, SessionFindFilesResult,
  SessionFileSearchMatch, SessionSearchFilesResult, SessionFileErrorCode,
  SessionFileListInput, SessionFileStatInput, SessionFileReadInput, SessionFileFindInput, SessionFileSearchInput,
} from "@vykor/protocol";

export interface SessionFileRequestOptions { signal?: AbortSignal }
export interface SessionFileListOptions extends SessionFileListInput, SessionFileRequestOptions {}
export interface SessionFileReadOptions extends Omit<SessionFileReadInput, "path">, SessionFileRequestOptions {}
export interface SessionFileFindOptions extends SessionFileFindInput, SessionFileRequestOptions {}
export interface SessionFileSearchOptions extends SessionFileSearchInput, SessionFileRequestOptions {}
