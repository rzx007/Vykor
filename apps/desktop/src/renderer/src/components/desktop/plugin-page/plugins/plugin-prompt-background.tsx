import { lazy, Suspense, useEffect, useRef, useState } from "react"

const ShaderBackground = lazy(() =>
  import("@renderer/components/motion/shader-background").then((module) => ({
    default: module.ShaderBackground,
  }))
)

/** Theme colors are resolved once per theme change; the shader renders a frozen frame. */
export function PluginPromptBackground(): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [colors, setColors] = useState<string[] | null>(null)
  useEffect(() => {
    if (!window.WebGL2RenderingContext || !host.current) return
    const probe = document.createElement("canvas")
    const graphics = probe.getContext("webgl2")
    if (!graphics) return
    graphics.getExtension("WEBGL_lose_context")?.loseContext()
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) return
    const updateColors = (): void => {
      if (!host.current) return
      const style = getComputedStyle(host.current)
      const palette = [1, 2, 3, 4].map((index) => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = style.getPropertyValue(`--plugin-prompt-color-${index}`).trim()
        context.fillRect(0, 0, 1, 1)
        const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
        return `rgb(${red}, ${green}, ${blue})`
      })
      setColors(palette)
    }
    updateColors()
    const observer = new MutationObserver(updateColors)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={host}
      aria-hidden="true"
      className="plugin-prompt-background pointer-events-none absolute inset-0"
    >
      {colors ? (
        <Suspense fallback={null}>
          <ShaderBackground
            variant="static-mesh-gradient"
            colors={colors}
            speed={0}
            positions={0.35}
            waveX={0.45}
            waveY={0.25}
            mixing={0.7}
            grainMixer={0}
            grainOverlay={0}
            maxPixelCount={400_000}
            className="absolute inset-0"
          />
        </Suspense>
      ) : null}
    </div>
  )
}
