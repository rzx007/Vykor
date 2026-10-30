export interface UploadAttachmentInput {
  displayName: string;
  mediaType?: string;
  body: Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface DownloadAttachmentOptions {
  range?: {
    start?: number;
    end?: number;
    suffixBytes?: number;
  };
  signal?: AbortSignal;
}
