export const DOCUMENT_PREVIEW_URL = "vykor-preview://app/index.html"
export const MAX_DOCUMENT_PREVIEW_BYTES = 64 * 1024 * 1024

export const documentMediaTypes = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const

export type DocumentFormat = keyof typeof documentMediaTypes
export interface LocalDocumentPreview {
  format: DocumentFormat
  bytes: ArrayBuffer
}

export function documentFormat(name: string): DocumentFormat | undefined {
  const extension = name.split(".").pop()?.toLowerCase() ?? ""
  return Object.hasOwn(documentMediaTypes, extension) ? (extension as DocumentFormat) : undefined
}
