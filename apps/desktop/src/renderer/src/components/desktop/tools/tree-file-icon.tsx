import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees"
import { useEffect } from "react"
import { documentTreeIcons } from "./document-file-icons"

const resolver = createFileTreeIconResolver(documentTreeIcons)
const sprite = getBuiltInSpriteSheet("complete") + (documentTreeIcons.spriteSheet ?? "")
const prefix = "vykor-tree-icons"
export function TreeFileIcon({ path, className }: { path: string; className?: string }) {
  const icon = resolver.resolveIcon("file-tree-icon-file", path.replace(/\\/g, "/"))
  useEffect(() => {
    if (document.getElementById(prefix)) return
    const definitions = document.createElement("div")
    definitions.id = prefix
    definitions.hidden = true
    definitions.innerHTML = sprite
      .replace(/id="([^"]+)"/g, `id="${prefix}-$1"`)
      .replace(/href="#([^"]+)"/g, `href="#${prefix}-$1"`)
    document.body.append(definitions)
  }, [])
  return (
    <span className={className} aria-hidden="true">
      <svg width="100%" height="100%" viewBox={icon.viewBox ?? "0 0 16 16"}>
        <use href={`#${prefix}-${icon.name}`} />
      </svg>
    </span>
  )
}
