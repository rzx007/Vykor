import { FileImage } from "lucide-react"
import { useCallback, useState } from "react"

import { DesktopEmptyState } from "@renderer/components/desktop/desktop-empty-state"
import type { SafeImageMediaType } from "@shared/safe-image-preview"
import { useImageViewer } from "@renderer/components/desktop/image-viewer/image-viewer-provider"

type FileImagePreviewProps = {
  bytes: ArrayBuffer
  mediaType: SafeImageMediaType
  name: string
  path?: string
}

type FailedImage = Pick<FileImagePreviewProps, "bytes" | "mediaType">

export function FileImagePreview({
  bytes,
  mediaType,
  name,
  path,
}: FileImagePreviewProps): React.JSX.Element {
  const viewer = useImageViewer()
  const [failedImage, setFailedImage] = useState<FailedImage | null>(null)
  const attachImage = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image) return
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
      let revoked = false
      const revoke = (): void => {
        if (revoked) return
        revoked = true
        URL.revokeObjectURL(objectUrl)
      }

      image.src = objectUrl
      return revoke
    },
    [bytes, mediaType]
  )

  if (failedImage?.bytes === bytes && failedImage.mediaType === mediaType) {
    return (
      <DesktopEmptyState icon={FileImage} size="sm" title={name} description="无法显示这张图片。" />
    )
  }

  return (
    <div className="relative flex h-full min-h-0 items-center justify-center overflow-auto bg-muted/30 p-4">
      <img
        ref={attachImage}
        alt={name}
        className="max-h-full max-w-full object-contain"
        onError={() => setFailedImage({ bytes, mediaType })}
      />
      {viewer && (
        <button
          type="button"
          aria-label={`查看图片 ${name}`}
          className="absolute inset-0 cursor-zoom-in rounded outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => viewer.openImage({ bytes, mediaType, name, path })}
        />
      )}
    </div>
  )
}
