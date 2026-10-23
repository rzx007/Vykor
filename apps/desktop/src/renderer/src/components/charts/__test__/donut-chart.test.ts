import { describe, expect, it } from "vitest"
import { buildDonut } from "../donut-chart/model"

const geometry = { radius: 86, thickness: 12, gap: 3 }
const segments = (values: number[]) =>
  values.map((value, index) => ({
    id: String(index),
    name: String(index),
    color: "var(--primary)",
    value,
  }))

describe("donut chart data geometry", () => {
  it("does not inflate tiny shares into overlapping round dots", () => {
    const { placed, total } = buildDonut(segments([9990, 4, 3, 2, 1]), geometry)
    expect(total).toBe(10000)
    for (const segment of placed.slice(1)) {
      expect(segment.linecap).toBe("butt")
      const coordinates = segment.path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number)
      const angle = (x: number, y: number) =>
        ((Math.atan2(x - 100, 100 - y) * 180) / Math.PI + 360) % 360
      const start = angle(coordinates[0], coordinates[1])
      const end = angle(coordinates.at(-2)!, coordinates.at(-1)!)
      const sweep = (end - start + 360) % 360
      expect(sweep).toBeCloseTo(segment.share * 360, 6)
    }
  })

  it("keeps zero and missing data out of the ring and draws a full circle for one part", () => {
    const { placed, total } = buildDonut(segments([0, NaN, 100, -1]), geometry)
    expect(total).toBe(100)
    expect(placed).toHaveLength(1)
    expect(placed[0].share).toBe(1)
    expect(placed[0].path.match(/ A /g)).toHaveLength(2)
    expect(buildDonut([], geometry)).toEqual({ placed: [], total: 0 })
  })
})
