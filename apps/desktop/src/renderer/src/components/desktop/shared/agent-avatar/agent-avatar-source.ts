import { Avatar, Style } from "@dicebear/core"
import planets from "@dicebear/styles/planets.json" with { type: "json" }

const planetStyle = new Style(planets)
// Keep the original hues and lightness, with 65% of their original saturation.
const planetColors = ["#63a1cb", "#8ea4db", "#7ba36e", "#4fa183", "#cd8c7a", "#aa9ed8"]
const sources = new Map<string, string>()
const cacheLimit = 256

export function agentAvatarSource(agentId: string): string {
  const cached = sources.get(agentId)
  if (cached) return cached

  const source = new Avatar(planetStyle, {
    seed: `vykor:agent-planet:v1:${agentId}`,
    backgroundColor: "#00000000",
    planetColor: planetColors,
    starProbability: 0,
    moonsProbability: 0,
    ringProbability: 45,
    ringVariant: "thin",
    animationVariant: "none",
  }).toDataUri()

  if (sources.size >= cacheLimit) {
    const oldest = sources.keys().next().value
    if (oldest !== undefined) sources.delete(oldest)
  }
  sources.set(agentId, source)
  return source
}
