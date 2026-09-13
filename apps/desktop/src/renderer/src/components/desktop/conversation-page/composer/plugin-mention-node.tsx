import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from "lexical"
import type { SessionUserInputItem } from "@shared/session-types"

type PluginReference = Extract<SessionUserInputItem, { type: "capability" }>
type SerializedPluginMention = SerializedLexicalNode & { item: PluginReference }

export class PluginMentionNode extends DecoratorNode<React.JSX.Element> {
  __item: PluginReference
  static getType(): string { return "plugin-mention" }
  static clone(node: PluginMentionNode): PluginMentionNode { return new PluginMentionNode(node.__item, node.__key) }
  static importJSON(node: SerializedPluginMention): PluginMentionNode { return new PluginMentionNode(node.item) }
  constructor(item: PluginReference, key?: NodeKey) { super(key); this.__item = { ...item } }
  exportJSON(): SerializedPluginMention { return { type: "plugin-mention", version: 1, item: { ...this.__item } } }
  createDOM(): HTMLElement {
    const element = document.createElement("span")
    element.className = "inline-flex align-baseline"
    return element
  }
  updateDOM(): false { return false }
  isInline(): boolean { return true }
  isKeyboardSelectable(): boolean { return false }
  getTextContent(): string { return `@${this.__item.displayName}` }
  decorate(): React.JSX.Element {
    return <span className="inline-flex items-center align-baseline font-medium !text-primary select-none">@{this.__item.displayName}</span>
  }
}
