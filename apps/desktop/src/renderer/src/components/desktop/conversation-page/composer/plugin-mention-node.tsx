import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from "lexical"
import type { SessionUserInputItem } from "@shared/session-types"
import { ExtensionIcon } from "../../plugin-page/shared/plugin-catalog"

type PluginReference = Extract<SessionUserInputItem, { type: "capability" }>
type SerializedPluginMention = SerializedLexicalNode & { item: PluginReference; icon?: string }

export class PluginMentionNode extends DecoratorNode<React.JSX.Element> {
  __item: PluginReference
  __icon?: string
  static getType(): string {
    return "plugin-mention"
  }
  static clone(node: PluginMentionNode): PluginMentionNode {
    return new PluginMentionNode(node.__item, node.__key, node.__icon)
  }
  static importJSON(node: SerializedPluginMention): PluginMentionNode {
    return new PluginMentionNode(node.item, undefined, node.icon)
  }
  constructor(item: PluginReference, key?: NodeKey, icon?: string) {
    super(key)
    this.__item = { ...item }
    this.__icon = icon
  }
  exportJSON(): SerializedPluginMention {
    return {
      type: "plugin-mention",
      version: 1,
      item: { ...this.__item },
      ...(this.__icon ? { icon: this.__icon } : {}),
    }
  }
  createDOM(): HTMLElement {
    const element = document.createElement("span")
    element.className = "inline align-baseline"
    return element
  }
  updateDOM(): false {
    return false
  }
  isInline(): boolean {
    return true
  }
  isKeyboardSelectable(): boolean {
    return false
  }
  getTextContent(): string {
    return `@${this.__item.displayName}`
  }
  decorate(): React.JSX.Element {
    return (
      <span className="align-baseline font-semibold !text-primary select-none">
        <span className="mr-1 inline-flex align-middle">
          <ExtensionIcon name="plugin" src={this.__icon} size="inline" />
        </span>
        <span>{this.__item.displayName}</span>
      </span>
    )
  }
}
