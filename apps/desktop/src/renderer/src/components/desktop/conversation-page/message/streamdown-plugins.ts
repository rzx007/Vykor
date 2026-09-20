import { cjk } from "@streamdown/cjk"
import type { CustomRenderer, PluginConfig } from "streamdown"

import { MermaidDiagram } from "./mermaid-diagram"

const customRenderers: CustomRenderer[] = [
  {
    component: MermaidDiagram,
    language: ["mermaid", "mmd"],
  },
]

const cspSafeCodeHighlighter: NonNullable<PluginConfig["code"]> = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages: () => [],
  getThemes: () => ["github-light", "github-dark"],
  supportsLanguage: () => false,
  highlight: () => null,
}

export const streamdownPlugins: PluginConfig = {
  cjk,
  code: cspSafeCodeHighlighter,
  renderers: customRenderers,
}
