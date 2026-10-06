import type { DesktopAttachmentPreview } from "@shared/attachment-types"

/** 来源决定打开和去重方式。截图等内存图片不需要伪造文件路径或先上传。 */
export type ImageSource = { name: string; readOnly?: boolean; draftId?: string } & (
  | { kind: "attachment"; assetId: string }
  | { kind: "file"; path: string; bytes: ArrayBuffer; mediaType: string }
  | { kind: "memory"; id: string; bytes: ArrayBuffer; mediaType: string }
)

export type ImageOpenRequest = { id: number; source: ImageSource }

export function imageSourceKey(source: ImageSource): string {
  const identity =
    source.kind === "attachment"
      ? source.assetId
      : source.kind === "file"
        ? source.path.replaceAll("\\", "/")
        : source.id
  return `image:${source.kind}:${identity}`
}

export async function readImageSource(source: ImageSource): Promise<DesktopAttachmentPreview> {
  const preview =
    source.kind === "attachment"
      ? await window.desktop.attachments.readPreview({ assetId: source.assetId })
      : { bytes: source.bytes, mediaType: source.mediaType }
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"].includes(
      preview.mediaType
    )
  ) {
    throw new Error("暂不支持预览这种图片格式")
  }
  return preview
}
