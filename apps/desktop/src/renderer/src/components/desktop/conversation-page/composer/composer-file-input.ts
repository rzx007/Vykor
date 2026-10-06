interface ComposerClipboardData {
  files: ArrayLike<File>
  getData: (type: string) => string
}

export const LONG_TEXT_ATTACHMENT_BYTES = 32 * 1024

export function shouldPasteAsTextAttachment(text: string): boolean {
  return new TextEncoder().encode(text).byteLength >= LONG_TEXT_ATTACHMENT_BYTES
}

export function readComposerClipboard(data: ComposerClipboardData): {
  files: File[]
  text: string
} {
  return {
    files: Array.from(data.files),
    text: data.getData("text/plain"),
  }
}

export function readComposerDrop(files: ArrayLike<File>): File[] {
  return Array.from(files)
}
