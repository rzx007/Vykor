export interface DonutSegment {
  id: string
  name: string
  /** A CSS color supplied by the consumer, such as "var(--chart-1)". */
  color: string
  /** Nonnegative value. Zero and invalid values are left out of the ring. */
  value: number
}

export type PlacedSegment = DonutSegment & {
  /** Share of the total, from 0 to 1. */
  share: number
  /** Centerline arc path in the 200 × 200 viewBox. */
  path: string
  /** Tiny shares use flat caps so their marks cannot exceed the allocated sweep. */
  linecap: "round" | "butt"
}

export const DONUT_SIZE = 200
const CENTER = DONUT_SIZE / 2

const point = (radius: number, degrees: number) => {
  const radians = (degrees * Math.PI) / 180
  return [CENTER + radius * Math.sin(radians), CENTER - radius * Math.cos(radians)]
}

/**
 * Lays segments clockwise from 12 o'clock as round-capped arcs. Each arc is
 * shortened by the gap plus its own cap, so neighbouring pills keep an even
 * gap. Tiny shares use their exact sweep and flat caps rather than inflated dots.
 */
export function buildDonut(
  segments: readonly DonutSegment[],
  { radius, thickness, gap }: { radius: number; thickness: number; gap: number }
) {
  const valid = segments.filter((segment) => Number.isFinite(segment.value) && segment.value > 0)
  const total = valid.reduce((sum, segment) => sum + segment.value, 0)
  const capDegrees = (thickness / 2 / radius) * (180 / Math.PI)
  const single = valid.length === 1
  let cursor = 0
  const placed: PlacedSegment[] = valid.map((segment) => {
    const share = total ? segment.value / total : 0
    const sweep = share * 360
    const linecap = single || sweep > gap + 2 * capDegrees ? "round" : "butt"
    const inset = single || linecap === "butt" ? 0 : gap / 2 + capDegrees
    const start = cursor + inset
    const end = cursor + sweep - inset
    cursor += sweep
    let path: string
    if (single) {
      // A full ring needs two half arcs; one arc cannot start and end together.
      const [x1, y1] = point(radius, 0)
      const [x2, y2] = point(radius, 180)
      path = `M ${x1} ${y1} A ${radius} ${radius} 0 1 1 ${x2} ${y2} A ${radius} ${radius} 0 1 1 ${x1} ${y1}`
    } else {
      const [x1, y1] = point(radius, start)
      const [x2, y2] = point(radius, end)
      path = `M ${x1} ${y1} A ${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${x2} ${y2}`
    }
    return { ...segment, share, path, linecap }
  })
  return { placed, total }
}
