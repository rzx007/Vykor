/// <reference types="vite/client" />
import {
  createViewer,
  pdfPlugin,
  epubPlugin,
  officePlugin,
  type FileViewer,
} from "@open-file-viewer/core"
import "@open-file-viewer/core/style.css"
import "./style.css"
import {
  documentFormat,
  documentMediaTypes,
  MAX_DOCUMENT_PREVIEW_BYTES,
} from "../shared/document-preview"

let viewer: FileViewer | undefined
const notify = (type: string, detail?: string) => parent.postMessage({ type, detail }, "*")
const base = new URL(/* @vite-ignore */ "../", import.meta.url)
const pdfOptions = {
  workerSrc: new URL("pdf.worker.mjs", base).href,
  cMapUrl: new URL("pdfjs/cmaps/", base).href,
  standardFontDataUrl: new URL("pdfjs/standard_fonts/", base).href,
  wasmUrl: new URL("pdfjs/wasm/", base).href,
  webFallbackScripts: "never" as const,
}

window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.type !== "document:open") return
  const { name, bytes, colors } = event.data
  const format = typeof name === "string" ? documentFormat(name) : undefined
  if (!format || !(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_DOCUMENT_PREVIEW_BYTES)
    return
  viewer?.destroy()
  document.title = name
  if (colors) {
    for (const key of ["background", "foreground", "border"] as const) {
      if (typeof colors[key] === "string" && CSS.supports("color", colors[key]))
        document.documentElement.style.setProperty(`--preview-${key}`, colors[key])
    }
  }
  viewer = createViewer({
    container: "#viewer",
    file: new File([bytes], name, { type: documentMediaTypes[format] }),
    fileName: name,
    width: "100%",
    height: "100%",
    fit: "width",
    locale: "zh-CN",
    theme: "light",
    toolbar: { download: false, fullscreen: false, print: false, rotate: false, search: false },
    plugins: [
      pdfPlugin(pdfOptions),
      epubPlugin(),
      officePlugin({ pdf: pdfOptions, docx: { renderAltChunks: false } }),
    ],
    onLoad: () => notify("document:loaded"),
    onError: (error) => notify("document:error", error.message),
    onUnsupported: () => notify("document:error", "无法预览此文档。"),
  })
})

// Block document links and navigation; this frame only displays the provided bytes.
document.addEventListener(
  "click",
  (event) => {
    if ((event.target as Element)?.closest?.("a")) event.preventDefault()
  },
  true
)
window.addEventListener("pagehide", () => viewer?.destroy())
notify("document:ready")
