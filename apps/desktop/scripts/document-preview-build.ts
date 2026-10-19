import { cpSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { build, type InlineConfig } from "vite"

const require = createRequire(import.meta.url)

function documentPreviewConfig(): InlineConfig {
  const output = resolve("out/document-preview")
  const pdfRoot = dirname(require.resolve("pdfjs-dist/package.json"))
  return {
    configFile: false,
    root: resolve("src/document-preview"),
    base: "./",
    publicDir: false,
    worker: { format: "es" },
    build: {
      outDir: output,
      emptyOutDir: true,
      rollupOptions: { external: ["@napi-rs/canvas"] },
    },
    plugins: [
      {
        name: "local-pdf-resources",
        writeBundle() {
          for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
            cpSync(resolve(pdfRoot, directory), resolve(output, "pdfjs", directory), {
              recursive: true,
            })
          }
          cpSync(resolve(pdfRoot, "build/pdf.worker.min.mjs"), resolve(output, "pdf.worker.mjs"))
        },
      },
    ],
  }
}

export async function buildDocumentPreview(): Promise<void> {
  await build(documentPreviewConfig())
}
