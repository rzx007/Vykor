export interface ImageRegion {
  id: string
  x: number
  y: number
  width: number
  height: number
  comment: string
}

export async function imageAnnotationKey(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return (
    "vykor-image-annotations-v1:" +
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  )
}

export function parseImageRegions(
  raw: string | null,
  width: number,
  height: number
): ImageRegion[] {
  try {
    const regions: unknown = JSON.parse(raw ?? "[]")
    if (!Array.isArray(regions) || regions.length > 100) return []
    const ids = new Set<string>()
    if (
      !regions.every((region) => {
        if (!region || typeof region !== "object") return false
        const { id, x, y, width: w, height: h, comment } = region
        if (
          typeof id !== "string" ||
          !id ||
          ids.has(id) ||
          typeof comment !== "string" ||
          comment.length > 2000
        )
          return false
        ids.add(id)
        return (
          [x, y, w, h].every((value) => typeof value === "number" && Number.isFinite(value)) &&
          x >= 0 &&
          y >= 0 &&
          w > 0 &&
          h > 0 &&
          x + w <= width + 0.01 &&
          y + h <= height + 0.01
        )
      })
    )
      return []
    return regions as ImageRegion[]
  } catch {
    return []
  }
}

export function imageFeedbackText(
  name: string,
  regions: readonly ImageRegion[],
  width: number,
  height: number
): string {
  const comments = regions.filter((region) => region.comment.trim())
  return [
    `请根据图片批注调整「${name}」。原图尺寸：${width} × ${height}。`,
    "附件包含原图和编号批注图；以下区域坐标为原图像素 (x, y, 宽, 高)。",
    ...comments.map(
      (region, index) =>
        `${index + 1}. 区域 (${[region.x, region.y, region.width, region.height].map(Math.round).join(", ")})：${region.comment.trim()}`
    ),
  ].join("\n")
}

/** 按原图尺寸生成快照；查看器的缩放、选中框和工具栏不进入附件。 */
export async function renderImageRegions(
  image: HTMLImageElement,
  regions: readonly ImageRegion[]
): Promise<Blob> {
  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext("2d")
  if (!context) throw new Error("无法生成图片批注")
  context.drawImage(image, 0, 0)
  const color =
    getComputedStyle(document.documentElement).getPropertyValue("--annotation").trim() || "#D94735"
  const fontSize = Math.max(16, Math.round(Math.min(canvas.width, canvas.height) / 45))
  context.lineWidth = Math.max(2, fontSize / 8)
  context.font = `600 ${fontSize}px sans-serif`
  const numbered = regions.filter((region) => region.comment.trim())
  numbered.forEach((region, index) => {
    context.strokeStyle = color
    context.strokeRect(region.x, region.y, region.width, region.height)
    const size = fontSize * 1.5
    const x = Math.max(0, Math.min(canvas.width - size, region.x))
    const y = Math.max(0, Math.min(canvas.height - size, region.y))
    context.fillStyle = color
    context.fillRect(x, y, size, size)
    context.fillStyle = "#FFFFFF"
    context.textAlign = "center"
    context.textBaseline = "middle"
    context.fillText(String(index + 1), x + size / 2, y + size / 2)
  })
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("无法导出图片"))), "image/png")
  )
}
