type OfficeFormat = "docx" | "pptx" | "xlsx"

export const OFFICE_MIN_ZOOM = 0.05
export const OFFICE_MAX_ZOOM = 16
const PAGE_PADDING = 12

function parseOfficeHtml(html: string): HTMLTemplateElement {
  // Template contents stay inert while measuring: no scripts, styles or
  // image/frame requests are activated in the application document.
  const content = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
  const template = document.createElement("template")
  template.innerHTML = content
  const doc = template.content
  doc
    .querySelectorAll('script, meta[http-equiv="refresh" i], base')
    .forEach((node) => node.remove())
  doc.querySelectorAll("a").forEach((node) => {
    node.setAttribute("inert", "")
    node.setAttribute("tabindex", "-1")
  })
  return template
}

function pixels(value: string | undefined): number {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*(px|pt|cm|mm|in)$/i)
  if (!match) return 0
  const unit = match[2].toLowerCase()
  const units: Record<string, number> = { px: 1, pt: 4 / 3, cm: 96 / 2.54, mm: 96 / 25.4, in: 96 }
  return Number(match[1]) * (units[unit] ?? 0)
}

function contentWidth(doc: ParentNode, format?: OfficeFormat): number {
  const selector =
    format === "xlsx" ? ".sheet-content.active table" : format === "docx" ? ".page" : ".slide"
  const widths = [...doc.querySelectorAll<HTMLElement>(selector)].map((node) =>
    pixels(node.style.width)
  )
  if (format === "pptx") {
    const css = [...doc.querySelectorAll("style")].map((node) => node.textContent).join("\n")
    widths.push(pixels(css.match(/--slide-design-w\s*:\s*([^;}]+)/)?.[1]))
  }
  const width = Math.max(0, ...widths)
  return width > 0 && width <= 100_000 ? width : format === "pptx" ? 1280 : 800
}

export function officePreviewWidth(html: string, format: OfficeFormat): number {
  return contentWidth(parseOfficeHtml(html).content, format) + PAGE_PADDING * 2
}

/** Opaque, scriptless iframe; remote assets and document actions remain blocked. */
export function officePreviewHtml(
  html: string,
  zoom: number,
  name?: string,
  format?: OfficeFormat
): string {
  const template = parseOfficeHtml(html)
  const doc = template.content
  const width = contentWidth(doc, format) + PAGE_PADDING * 2
  if (name) {
    let title = doc.querySelector("title")
    if (!title) {
      title = document.createElement("title")
      doc.prepend(title)
    }
    title.textContent = name
    doc.querySelectorAll(".file-title").forEach((node) => {
      node.textContent = name
    })
  }
  const scale = Number.isFinite(zoom)
    ? Math.min(OFFICE_MAX_ZOOM, Math.max(OFFICE_MIN_ZOOM, zoom))
    : 1
  const policy = document.createElement("meta")
  policy.httpEquiv = "Content-Security-Policy"
  policy.content =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
  const style = document.createElement("style")
  style.textContent = `
html{zoom:${scale}!important}
body{box-sizing:border-box!important;width:${width}px!important;height:auto!important;min-height:0!important;margin:0!important;padding:${PAGE_PADDING}px!important;overflow:auto!important}
.sidebar,.toolbar,.sheet-tabs,.page-counter,.toggle-zone,.file-title,.slide-label{display:none!important}
.main{display:block!important;height:auto!important;min-height:0!important;padding:0!important;overflow:visible!important}
.slide-container{margin:0!important;padding:0!important}
.slide-wrapper{justify-content:flex-start!important}
.sheet-slider{display:block!important;overflow:visible!important;flex:none!important}
.sheet-content.active{display:block!important}
a{pointer-events:none!important}`
  return `<!doctype html><html><head>${policy.outerHTML}</head><body>${template.innerHTML}${style.outerHTML}</body></html>`
}
