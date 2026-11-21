import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  $createRangeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  type TextNode,
} from "lexical"

import {
  ComposerPicker,
  type ComposerPickerCommand,
  type ComposerPickerItem,
  type ComposerPickerSkill,
} from "./composer-picker"
import { pickerItems } from "./composer-picker-model"
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
import { leadingSessionObservationLine, sessionObservationDirective } from "../shared/session-observation"

export function ComposerPickerPlugin({
  disabled,
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
  disabled: boolean
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
  const closePicker = useCallback(() => {
    setManualContextOpen(false)
    setDismissed(triggerKey(editor.getEditorState().read(triggerFromEditorState)))
  }, [editor])
  const previousRequest = useRef(contextPickerRequest)
  useEffect(() => {
    if (contextPickerRequest === previousRequest.current) return
    previousRequest.current = contextPickerRequest
    if (contextPickerOpen) setManualContextOpen(true)
    else closePicker()
  }, [closePicker, contextPickerOpen, contextPickerRequest])
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const next = editorState.read(triggerFromEditorState)
        setTrigger(next)
        const nextKey = triggerKey(next)
        setDismissed((current) => current === nextKey ? current : null)
      }),
    [editor]
  )
  useEffect(() => setTrigger(editor.getEditorState().read(triggerFromEditorState)), [editor])
  const activeTrigger = dismissed === triggerKey(trigger) ? null : trigger
  const contextVisible = manualContextOpen || activeTrigger?.sigil === "@"
  useEffect(
    () => onContextPickerOpenChange?.(contextVisible),
    [contextVisible, onContextPickerOpenChange]
  )

  if (disabled) return null
  if (contextVisible) {
    const contextTrigger = trigger?.sigil === "@" ? trigger : undefined
    return (
      <ContextPicker
        items={contextItems}
        query={manualContextOpen ? "" : (contextTrigger?.query ?? "")}
        onDismiss={closePicker}
        onSelect={(item) => {
          const { action } = item
          if (action.kind === "observe-session") {
            insertObservationDirective(editor, action.sessionId, manualContextOpen ? undefined : contextTrigger)
            closePicker()
            return
          }
          setManualContextOpen(false)
          if (action.kind === "conversation") {
            insertContextMention(editor, action.sessionId, action.displayName, contextTrigger)
          } else if (action.kind === "plugin") {
            const { pluginId, displayName } = action
            editor.update(
              () => {
                const mention = new PluginMentionNode(
                  {
                    type: "capability",
                    kind: "plugin",
                    pluginId,
                    displayName,
                  },
                  undefined,
                  item.icon
                )
                if (contextTrigger) replaceTriggerWithNode(contextTrigger, mention)
                else {
                  const selection = $getSelection()
                  if ($isRangeSelection(selection))
                    selection.insertNodes([mention, $createTextNode(" ")])
                  else
                    $getRoot()
                      .selectEnd()
                      .insertNodes([mention, $createTextNode(" ")])
                }
              },
              { discrete: true }
            )
          } else {
            if (contextTrigger) removeComposerTrigger(editor, contextTrigger)
            onContextAction?.(item)
          }
        }}
      />
    )
  }
  if (!activeTrigger) return null
  const skillItems: ComposerPickerItem[] = skills.map((skill) => ({
    id: `skill:${skill.path}`,
    kind: "skill",
    label: skill.displayName,
    description: skill.description,
    sourceLabel: skill.sourceLabel,
    skill,
  }))
  const items = pickerItems({
    trigger: activeTrigger,
    commands: editor.getEditorState().read(() => canExecuteComposerCommand(activeTrigger))
      ? commands
      : [],
    skills: skillItems,
  })
  return (
    <ComposerPicker
      items={items}
      label={activeTrigger.sigil === "$" ? "技能" : "命令和技能"}
      query=""
      onDismiss={closePicker}
      onSelect={(item) => {
        if (item.skill) {
          insertSkillMention(editor, activeTrigger, item.skill)
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

function triggerKey(trigger: ComposerTrigger | null): string | null {
  return trigger ? `${trigger.from}:${trigger.to}:${trigger.query}` : null
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
  editor.update(() => $removeComposerTrigger(trigger), { discrete: true })
}

function $removeComposerTrigger(trigger: ComposerTrigger): void {
  const leaves = textLeaves()
  const start = leaves.find((leaf) => leaf.from <= trigger.from && leaf.to > trigger.from)
  const end = leaves.find((leaf) => leaf.from < trigger.to && leaf.to >= trigger.to)
  if (!$isTextNode(start?.node) || !$isTextNode(end?.node)) return
  const selection = $createRangeSelection()
  selection.setTextNodeRange(start.node, trigger.from - start.from, end.node, trigger.to - end.from)
  $setSelection(selection)
  selection.removeText()
}

function insertObservationDirective(editor: LexicalEditor, sessionId: string, trigger?: ComposerTrigger): void {
  editor.update(
    () => {
      const root = $getRoot()
      const directive = sessionObservationDirective(sessionId)
      const firstItem = composerDocumentFromLexical().items[0]
      const firstText = firstItem?.type === "text" ? firstItem.text : ""
      const previousLine = leadingSessionObservationLine(firstText)
      if (trigger && (!previousLine || trigger.from >= previousLine.length)) {
        $removeComposerTrigger(trigger)
      }
      let moveCaret = false
      if (previousLine) {
        const newlineAt = firstText.indexOf("\n")
        const leaves = textLeaves()
        const lineBreak = leaves.find((leaf) => leaf.from === newlineAt && $isLineBreakNode(leaf.node))?.node
        const firstParagraph = root.getFirstChild()
        const selection = $getSelection()
        moveCaret = $isRangeSelection(selection) && [selection.anchor, selection.focus].some((point) => {
          if (point.type === "text") {
            const leaf = leaves.find((leaf) => leaf.node.getKey() === point.key)
            return leaf !== undefined && leaf.from + point.offset <= previousLine.length
          }
          return (point.key === root.getKey() && point.offset === 0) ||
            (point.key === firstParagraph?.getKey() && (!lineBreak || point.offset <= lineBreak.getIndexWithinParent()))
        })
        for (const leaf of leaves) {
          if (leaf.from >= previousLine.length) break
          if ($isTextNode(leaf.node)) {
            leaf.node.spliceText(
              0,
              Math.min(leaf.to, previousLine.length) - leaf.from,
              leaf.from === 0 && newlineAt >= 0 ? directive : ""
            )
          }
        }
        if (newlineAt >= 0) {
          if (moveCaret) {
            if (lineBreak) lineBreak.selectNext(0, 0)
            else firstParagraph?.getNextSibling()?.selectStart()
          }
          return
        }
      }
      const paragraph = $createParagraphNode().append($createTextNode(directive))
      const body = root.getFirstChild()
      if (body) body.insertBefore(paragraph)
      else root.append(paragraph, $createParagraphNode())
      if (moveCaret) body?.selectStart()
      else if (!$getSelection()) root.selectEnd()
    },
    { discrete: true, tag: HISTORY_PUSH_TAG }
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
  const insert = command.selection === "insert"
  editor.update(
    () => {
      const root = $getRoot()
      root.clear()
      const paragraph = $createParagraphNode()
      if (insert) paragraph.append($createTextNode(`/${command.id} `))
      root.append(paragraph)
      paragraph.selectEnd()
    },
    { discrete: true, tag: insert ? HISTORY_PUSH_TAG : undefined }
  )
  if (insert) return
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
            (item) =>
              $isSkillMentionNode(item.node) ||
              item.node instanceof ResourceMentionNode ||
              item.node instanceof PluginMentionNode
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
