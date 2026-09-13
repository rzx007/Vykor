import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { useEffect } from "react"
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  CUT_COMMAND,
  PASTE_COMMAND,
  type RangeSelection,
} from "lexical"

import { composerDocument, type ComposerDocument } from "@renderer/stores/desktop-session/composer-document"
import { readComposerClipboard } from "./composer-file-input"
import { composerDocumentFromLexical, composerParagraphs, descendantLeaves, textLeaves } from "./composer-lexical-document"
import type { ComposerSkill } from "./composer-types"

const COMPOSER_CLIPBOARD_TYPE = "application/x-openharness-composer"

function selectedComposerDocument(selection: RangeSelection): ComposerDocument {
  const leaves = textLeaves()
  const pointOffset = (point: RangeSelection["anchor"]): number => {
    const node = point.getNode()
    if (node === $getRoot()) {
      const paragraphs = $getRoot().getChildren()
      return paragraphs.slice(0, point.offset).reduce((sum, paragraph) => sum + paragraph.getTextContent().length, 0) + Math.min(point.offset, Math.max(0, paragraphs.length - 1))
    }
    if ($isTextNode(node)) return (leaves.find((leaf) => leaf.node === node)?.from ?? 0) + point.offset
    if ($isElementNode(node)) {
      const after = node.getChildren().slice(point.offset).flatMap(descendantLeaves)[0]
      const next = leaves.find((leaf) => leaf.node === after)
      if (next) return next.from
      const last = descendantLeaves(node).at(-1)
      const end = leaves.find((leaf) => leaf.node === last)
      if (end) return end.to
      let offset = 0
      for (const paragraph of $getRoot().getChildren()) {
        if (paragraph === node) return offset
        offset += paragraph.getTextContent().length + 1
      }
    }
    return 0
  }
  const [start, end] = [pointOffset(selection.anchor), pointOffset(selection.focus)].sort((a, b) => a - b)
  let offset = 0
  return composerDocument(composerDocumentFromLexical().items.flatMap((item): ComposerDocument["items"] => {
    const length = item.type === "text" ? item.text.length : item.type === "context" || item.type === "capability" ? item.displayName.length + 1 : item.name.length + 1
    const from = offset
    offset += length
    if (end <= from || start >= offset) return []
    return item.type === "text" ? [{ type: "text" as const, text: item.text.slice(Math.max(0, start - from), end - from) }] : [item]
  }))
}

function readStructuredClipboard(raw: string, skills: readonly ComposerSkill[]): ComposerDocument | null {
  if (!raw || raw.length > 2 * 1024 * 1024) return null
  try {
    const value = JSON.parse(raw)
    if (value?.version !== 1 || !Array.isArray(value.items) || value.items.length > 256) return null
    const items: ComposerDocument["items"] = []
    for (const item of value.items) {
      if (item?.type === "text" && typeof item.text === "string") {
        items.push({ type: "text", text: item.text })
        continue
      }
      if (item?.type === "context") {
        if (item.kind !== "conversation" || typeof item.id !== "string" || typeof item.displayName !== "string") return null
        items.push({ type: "context", kind: "conversation", id: item.id, displayName: item.displayName })
        continue
      }
      if (item?.type === "capability") {
        if (typeof item.pluginId !== "string" || !item.pluginId.trim() || typeof item.displayName !== "string" || !item.displayName.trim()) return null
        if (item.kind === "plugin") items.push({ type: "capability", kind: "plugin", pluginId: item.pluginId, displayName: item.displayName })
        else if (item.kind === "plugin_agent" && typeof item.agentId === "string" && item.agentId.trim()) items.push({ type: "capability", kind: "plugin_agent", pluginId: item.pluginId, agentId: item.agentId, displayName: item.displayName })
        else return null
        continue
      }
      if ((item?.type !== "skill" && item?.type !== "mention") || typeof item.name !== "string" || typeof item.path !== "string" || (item.displayName !== undefined && typeof item.displayName !== "string")) return null
      if (item.type === "skill" && !skills.some((skill) => skill.name === item.name && skill.path === item.path)) {
        items.push({ type: "text", text: `$${item.name}` })
      } else {
        items.push({
          type: item.type,
          name: item.name,
          path: item.path,
          ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
          ...(item.type === "skill" && isSkillSource(item.source) ? { source: item.source } : {}),
        })
      }
    }
    return composerDocument(items)
  } catch {
    return null
  }
}

export function ComposerClipboardPlugin({ onPasteFiles, skills }: { onPasteFiles?: (files: readonly File[]) => void; skills: readonly ComposerSkill[] }): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const copy = (event: ClipboardEvent | KeyboardEvent | null, cut = false): boolean => {
      if (!event || !("clipboardData" in event) || !event.clipboardData) return false
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false
      const value = selectedComposerDocument(selection)
      event.preventDefault()
      event.clipboardData.setData(COMPOSER_CLIPBOARD_TYPE, JSON.stringify(value))
      event.clipboardData.setData("text/plain", value.items.map((item) => item.type === "text" ? item.text : item.type === "context" || item.type === "capability" ? `@${item.displayName}` : `${item.type === "skill" ? "$" : "@"}${item.name}`).join(""))
      if (cut) selection.removeText()
      return true
    }
    const removeCopy = editor.registerCommand(COPY_COMMAND, (event) => copy(event), COMMAND_PRIORITY_HIGH)
    const removeCut = editor.registerCommand(CUT_COMMAND, (event) => copy(event, true), COMMAND_PRIORITY_HIGH)
    return () => { removeCopy(); removeCut() }
  }, [editor])
  useEffect(() => editor.registerCommand(PASTE_COMMAND, (event) => {
    if (!("clipboardData" in event) || !event.clipboardData) return false
    const { files, text } = readComposerClipboard(event.clipboardData)
    const structured = readStructuredClipboard(event.clipboardData.getData(COMPOSER_CLIPBOARD_TYPE), skills)
    if (files.length === 0 && !text && !structured) return false
    event.preventDefault()
    if (files.length > 0) onPasteFiles?.(files)
    editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) return
      if (structured) selection.insertNodes(composerParagraphs(structured))
      else if (text) selection.insertRawText(text)
    })
    return true
  }, COMMAND_PRIORITY_HIGH), [editor, onPasteFiles, skills])
  return null
}

function isSkillSource(value: string): value is NonNullable<ComposerSkill["source"]> {
  return value === "bundled" || value === "user" || value === "project" || value === "plugin"
}
