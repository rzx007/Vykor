import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { useEffect, useRef, useState } from "react"
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
  type TextNode,
} from "lexical"

import {
  ComposerPicker,
  pickerItems,
  type ComposerPickerCommand,
  type ComposerPickerItem,
  type ComposerPickerSkill,
} from "./composer-picker"
import { ContextPicker, type ContextPickerItem } from "./context-picker"
import { findComposerTrigger, type ComposerTrigger } from "./composer-trigger"
import {
  composerDocumentFromLexical,
  editorText,
  restoreComposerDocument,
  textLeaves,
} from "./composer-lexical-document"
import { ResourceMentionNode } from "./resource-mention-node"
import { PluginMentionNode } from "./plugin-mention-node"
import { $createSkillMentionNode, $isSkillMentionNode } from "./skill-mention-node"
import type { ComposerSkill } from "./composer-types"

export function ComposerPickerPlugin({
  skills,
  commands,
  contextItems,
  contextPickerRequest,
  contextPickerOpen,
  onContextAction,
  onContextPickerOpenChange,
  onCommand,
  onCommandError,
}: {
  skills: readonly ComposerSkill[]
  commands: readonly ComposerPickerItem[]
  contextItems: readonly ContextPickerItem[]
  contextPickerRequest: number
  contextPickerOpen: boolean
  onContextAction?: (item: ContextPickerItem) => void
  onContextPickerOpenChange?: (open: boolean) => void
  onCommand: (command: ComposerPickerCommand) => Promise<void>
  onCommandError: (message: string | null) => void
}): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [manualContextOpen, setManualContextOpen] = useState(false)
  const previousRequest = useRef(contextPickerRequest)
  useEffect(() => {
    if (contextPickerRequest === previousRequest.current) return
    previousRequest.current = contextPickerRequest
    setManualContextOpen(contextPickerOpen)
    if (!contextPickerOpen && trigger) setDismissed(`${trigger.from}:${trigger.to}:${trigger.query}`)
  }, [contextPickerOpen, contextPickerRequest])
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const next = editorState.read(triggerFromEditorState)
        setTrigger(next)
        setDismissed((current) => next && current === `${next.from}:${next.to}:${next.query}` ? current : null)
      }),
    [editor]
  )
  useEffect(() => setTrigger(editor.getEditorState().read(triggerFromEditorState)), [editor])
  const contextVisible = Boolean(manualContextOpen || (trigger?.sigil === "@" && dismissed !== `${trigger.from}:${trigger.to}:${trigger.query}`))
  useEffect(() => onContextPickerOpenChange?.(contextVisible), [contextVisible, onContextPickerOpenChange])

  const visible =
    manualContextOpen || (trigger && dismissed !== `${trigger.from}:${trigger.to}:${trigger.query}`)
  if (!visible) return null
  const skillItems: ComposerPickerItem[] = skills.map((skill) => ({
    id: `skill:${skill.path}`,
    kind: "skill",
    label: skill.displayName,
    description: skill.description,
    sourceLabel: skill.sourceLabel,
    skill,
  }))
  const contextMode = manualContextOpen || trigger?.sigil === "@"
  if (contextMode) {
    return (
      <ContextPicker
        items={contextItems}
        query={manualContextOpen ? "" : trigger?.query ?? ""}
        onDismiss={() => {
          setManualContextOpen(false)
          if (trigger) setDismissed(`${trigger.from}:${trigger.to}:${trigger.query}`)
        }}
        onSelect={(item) => {
          setManualContextOpen(false)
          if (item.action.kind === "conversation") {
            insertContextMention(editor, item.action.sessionId, item.action.displayName, trigger?.sigil === "@" ? trigger : undefined)
          } else if (item.action.kind === "plugin") {
            const { pluginId, displayName } = item.action
            editor.update(() => {
              const mention = new PluginMentionNode({ type: "capability", kind: "plugin", pluginId, displayName })
              if (trigger?.sigil === "@") replaceTriggerWithNode(trigger, mention)
              else {
                const selection = $getSelection()
                if ($isRangeSelection(selection)) selection.insertNodes([mention, $createTextNode(" ")])
                else $getRoot().selectEnd().insertNodes([mention, $createTextNode(" ")])
              }
            }, { discrete: true })
          } else {
            if (trigger?.sigil === "@") removeComposerTrigger(editor, trigger)
            onContextAction?.(item)
          }
        }}
      />
    )
  }
  const items = pickerItems({
    trigger: trigger!,
    commands: editor.getEditorState().read(() => canExecuteComposerCommand(trigger)) ? commands : [],
    skills: skillItems,
  })
  return (
    <ComposerPicker
      items={items}
      label={trigger?.sigil === "$" ? "技能" : "命令和技能"}
      query=""
      onDismiss={() => {
        setManualContextOpen(false)
        if (trigger) setDismissed(`${trigger.from}:${trigger.to}:${trigger.query}`)
      }}
      onSelect={(item) => {
        if (item.skill && trigger) {
          insertSkillMention(editor, trigger, item.skill)
          return
        }
        if (item.command) {
          onCommandError(null)
          void executeComposerCommand(editor, item.command, onCommand, onCommandError)
        }
      }}
    />
  )
}

function insertContextMention(
  editor: LexicalEditor,
  id: string,
  displayName: string,
  trigger?: ComposerTrigger
): void {
  editor.update(
    () => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) return
      const mention = new ResourceMentionNode({
        type: "context",
        kind: "conversation",
        id,
        displayName,
      })
      if (!trigger) {
        selection.insertNodes([mention, $createTextNode(" ")])
        return
      }
      replaceTriggerWithNode(trigger, mention)
    },
    { discrete: true }
  )
}

function removeComposerTrigger(editor: LexicalEditor, trigger: ComposerTrigger): void {
  editor.update(
    () => {
      const leaf = textLeaves().find(
        (item) => $isTextNode(item.node) && item.from <= trigger.from && item.to >= trigger.to
      )
      if (!leaf || !$isTextNode(leaf.node)) return
      const fragments = leaf.node.splitText(trigger.from - leaf.from, trigger.to - leaf.from)
      fragments[trigger.from === leaf.from ? 0 : 1]?.remove()
    },
    { discrete: true }
  )
}

export async function executeComposerCommand(
  editor: LexicalEditor,
  command: ComposerPickerCommand,
  onCommand: (command: ComposerPickerCommand) => Promise<void>,
  onError: (message: string) => void = () => {}
): Promise<void> {
  if (!editor.getEditorState().read(() => canExecuteComposerCommand())) return
  const previous = editor.getEditorState().read(composerDocumentFromLexical)
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      root.append(paragraph)
      paragraph.selectEnd()
    },
    { discrete: true }
  )
  try {
    await onCommand(command)
  } catch (error) {
    editor.update(() => restoreComposerDocument(previous), { discrete: true })
    onError(error instanceof Error ? error.message : String(error))
  }
}

function canExecuteComposerCommand(trigger?: ComposerTrigger | null): boolean {
  const document = composerDocumentFromLexical()
  if (document.items.some((item) => item.type !== "text")) return false
  const text = document.items.map((item) => (item.type === "text" ? item.text : "")).join("")
  const current = trigger ?? findComposerTrigger(text, text.trimEnd().length)
  return (
    !!current &&
    current.sigil === "/" &&
    current.mode === "leading" &&
    (text.slice(0, current.from) + text.slice(current.to)).trim() === ""
  )
}

export function triggerFromEditorState(): ComposerTrigger | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null
  const anchor = selection.anchor.getNode()
  if (!$isTextNode(anchor)) return null
  const leaves = textLeaves()
  const leaf = leaves.find((item) => item.node === anchor)
  return leaf
    ? findComposerTrigger(editorText(leaves), leaf.from + selection.anchor.offset, {
        atomicBoundaries: leaves
          .filter(
            (item) => $isSkillMentionNode(item.node) || item.node instanceof ResourceMentionNode || item.node instanceof PluginMentionNode
          )
          .map((item) => item.to),
      })
    : null
}

export function insertSkillMention(
  editor: LexicalEditor,
  trigger: ComposerTrigger,
  skill: ComposerPickerSkill
): void {
  editor.update(
    () => {
      const mention = $createSkillMentionNode(
        skill.name,
        skill.path,
        skill.displayName ?? skill.name,
        skill.source ?? ""
      )
      replaceTriggerWithNode(trigger, mention)
    },
    { discrete: true }
  )
}

function replaceTriggerWithNode(
  trigger: ComposerTrigger,
  mention: ResourceMentionNode | PluginMentionNode | ReturnType<typeof $createSkillMentionNode>
): void {
  const leaf = textLeaves().find(
    (item) => $isTextNode(item.node) && item.from <= trigger.from && item.to >= trigger.to
  )
  if (!leaf || !$isTextNode(leaf.node)) return
  const start = trigger.from - leaf.from
  const end = trigger.to - leaf.from
  const fragments = (leaf.node as TextNode).splitText(start, end)
  const selectedIndex = start === 0 ? 0 : 1
  const selected = fragments[selectedIndex]
  const after = fragments[selectedIndex + 1]
  if (!selected) return
  selected.replace(mention)
  const spacer = after?.getTextContent().startsWith(" ") ? null : $createTextNode(" ")
  if (spacer) mention.insertAfter(spacer)
  const caretNode = spacer ?? after
  if (caretNode && $isTextNode(caretNode)) caretNode.select(1, 1)
}
