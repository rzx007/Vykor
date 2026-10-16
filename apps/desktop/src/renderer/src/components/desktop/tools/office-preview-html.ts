/** The document runs in an opaque, scriptless iframe; this CSP also blocks remote assets. */
export function officePreviewHtml(html: string, zoom: number): string {
  const content = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "")
    .replace(/<a\b/gi, '<a inert tabindex="-1"')
  const scale = Number.isFinite(zoom) ? Math.min(2, Math.max(0.25, zoom)) : 0.6
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><style>html{zoom:${scale}}body{height:auto!important;min-height:100vh;overflow:auto!important}.sidebar,.toolbar,.sheet-tabs,.page-counter,.toggle-zone{display:none!important}.main{align-items:flex-start!important;overflow:visible!important}.slide-wrapper{justify-content:flex-start!important}a{pointer-events:none!important}</style></head><body>${content}</body></html>`
}
