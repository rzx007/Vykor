import "./upstream/rings.js"
import "./upstream/emotions.js"
import "./upstream/ball.js"
import "./upstream/engine.js"

type AoraInstance = {
  setActive: (active: boolean) => void
  renderStatic: () => void
  destroy: () => void
}

type AoraLibrary = {
  create: (
    container: HTMLElement,
    options: {
      emotion: string
      shape: string
      color: string
      eyeColor: string
      eyeScale: number
      autostart: boolean
      lite: boolean
    }
  ) => AoraInstance
}

declare global {
  interface Window {
    EmotionBall: AoraLibrary
  }
}

const shapes = ["blob", "wedge", "gem"] as const
const colors = ["#F3F0EA", "#D8E6F3", "#E3DDF0", "#E4EBD4", "#F4DDD3", "#F4E8BD"] as const

function identityHash(name: string): number {
  let hash = 2166136261
  for (const character of name) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  }
  return hash >>> 0
}

export function mountAoraAvatar(container: HTMLElement, name: string, size: number): () => void {
  const hash = identityHash(name)
  const avatar = window.EmotionBall.create(container, {
    emotion: "02",
    shape: shapes[hash % shapes.length],
    color: colors[(hash >>> 8) % colors.length],
    eyeColor: "#1A1A1A",
    eyeScale: size <= 120 ? 1.5 : 1,
    autostart: false,
    lite: true,
  })
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)")
  let disposed = false

  const updateActivity = (): void => {
    if (disposed) return
    const preference = document.documentElement.dataset.reducedMotion
    const reducedMotion = preference === undefined ? Boolean(media?.matches) : preference === "true"
    const active = !reducedMotion && document.visibilityState !== "hidden"
    avatar.setActive(active)
    if (!active) avatar.renderStatic()
  }

  const observer = new MutationObserver(updateActivity)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-reduced-motion"],
  })
  document.addEventListener("visibilitychange", updateActivity)
  media?.addEventListener("change", updateActivity)
  updateActivity()

  return () => {
    disposed = true
    observer.disconnect()
    document.removeEventListener("visibilitychange", updateActivity)
    media?.removeEventListener("change", updateActivity)
    avatar.destroy()
  }
}
