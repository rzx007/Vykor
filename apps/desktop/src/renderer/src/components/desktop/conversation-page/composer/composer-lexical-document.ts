import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { useEffect, useRef } from "react"
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  type LexicalNode,
} from "lexical"

import {
  composerDocument,
  sameComposerDocument,
  type ComposerDocument,
} from "@renderer/stores/desktop-session/composer-document"
import { ResourceMentionNode } from "./resource-mention-node"
import { PluginMentionNode } from "./plugin-mention-node"
import { $createSkillMentionNode, $isSkillMentionNode } from "./skill-mention-node"

export interface TextLeaf {
  node: LexicalNode
  from: number
  to: number
}

export function composerDocumentFromLexical(): ComposerDocument {
  const items: ComposerDocument["items"] = []
  const paragraphs = $getRoot().getChildren()
  paragraphs.forEach((paragraph, index) => {
    for (const node of descendantLeaves(paragraph)) {
      if ($isSkillMentionNode(node)) {
        items.push({
          type: "skill",
          name: node.__name,
          path: node.__path,
          displayName: node.__displayName,
          ...(isSkillSource(node.__source) ? { source: node.__source } : {}),
        })
      } else if (node instanceof ResourceMentionNode || node instanceof PluginMentionNode) {
        items.push({ ...node.__item })
      } else {
        const text = node.getTextContent()
        if (text) items.push({ type: "text", text })
      }
    }
    if (index < paragraphs.length - 1) items.push({ type: "text", text: "\n" })
  })
  return composerDocument(items)
}

export function restoreComposerDocument(value: ComposerDocument): void {
  const root = $getRoot()
  root.clear()
  const paragraphs = composerParagraphs(value)
  root.append(...paragraphs)
  paragraphs.at(-1)!.selectEnd()
}

export function composerParagraphs(value: ComposerDocument) {
  let paragraph = $createParagraphNode()
  const paragraphs = [paragraph]
  for (const item of value.items) {
    if (item.type === "text") {
      item.text.split("\n").forEach((text, index) => {
        if (index > 0) {
          paragraph = $createParagraphNode()
          paragraphs.push(paragraph)
        }
        if (text) paragraph.append($createTextNode(text))
      })
    } else if (item.type === "skill") {
      paragraph.append($createSkillMentionNode(item.name, item.path, item.displayName ?? item.name, item.source ?? ""))
    } else if (item.type === "capability") {
      paragraph.append(new PluginMentionNode(item))
    } else {
      paragraph.append(new ResourceMentionNode(item))
    }
  }
  return paragraphs
}

export function textLeaves(): TextLeaf[] {
  const leaves: TextLeaf[] = []
  let offset = 0
  $getRoot().getChildren().forEach((paragraph, index) => {
    if (index > 0) offset += 1
    for (const node of descendantLeaves(paragraph)) {
      const text = node.getTextContent()
      leaves.push({ node, from: offset, to: offset + text.length })
      offset += text.length
    }
  })
  return leaves
}

export function editorText(leaves: TextLeaf[]): string {
  let text = ""
  for (const leaf of leaves) text += "\n".repeat(Math.max(0, leaf.from - text.length)) + leaf.node.getTextContent()
  return text
}

export function descendantLeaves(node: LexicalNode): LexicalNode[] {
  return $isElementNode(node) ? node.getChildren().flatMap(descendantLeaves) : [node]
}

export function SyncDraftPlugin({ value, onChange }: { value: ComposerDocument; onChange: (value: ComposerDocument) => void }): null {
  const [editor] = useLexicalComposerContext()
  const syncingRef = useRef(false)
  useEffect(() => editor.registerUpdateListener(() => {
    if (syncingRef.current) return
    const next = editor.getEditorState().read(composerDocumentFromLexical)
    if (!sameComposerDocument(next, value)) onChange(next)
  }), [editor, onChange, value])
  useEffect(() => {
    if (sameComposerDocument(editor.getEditorState().read(composerDocumentFromLexical), value)) return
    syncingRef.current = true
    editor.update(() => restoreComposerDocument(value))
    queueMicrotask(() => { syncingRef.current = false })
  }, [editor, value])
  return null
}

function isSkillSource(value: string): value is "bundled" | "user" | "project" | "plugin" {
  return value === "bundled" || value === "user" || value === "project" || value === "plugin"
}
