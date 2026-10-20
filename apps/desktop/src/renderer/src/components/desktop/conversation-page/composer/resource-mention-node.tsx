import { DecoratorNode, type NodeKey, type SerializedLexicalNode } from "lexical"
import { MessageSquare } from "lucide-react"
import type { SessionUserInputItem } from "@shared/session-types"

type Mention = Extract<SessionUserInputItem, { type: "mention" | "context" }>
type SerializedMention = SerializedLexicalNode & { item: Mention }

export class ResourceMentionNode extends DecoratorNode<React.JSX.Element> {
  __item: Mention
  static getType(): string {
    return "resource-mention"
  }
  static clone(node: ResourceMentionNode): ResourceMentionNode {
    return new ResourceMentionNode(node.__item, node.__key)
  }
  static importJSON(node: SerializedMention): ResourceMentionNode {
    return new ResourceMentionNode(node.item)
  }
  constructor(item: Mention, key?: NodeKey) {
    super(key)
    this.__item = { ...item }
  }
  exportJSON(): SerializedMention {
    return { type: "resource-mention", version: 1, item: { ...this.__item } }
  }
  createDOM(): HTMLElement {
    const element = document.createElement("span")
    element.className = "inline align-baseline"
    return element
  }
  updateDOM(): false {
    return false
  }
  getTextContent(): string {
    return `@${this.__item.type === "context" ? this.__item.displayName : this.__item.name}`
  }
  isInline(): boolean {
    return true
  }
  decorate(): React.JSX.Element {
    if (this.__item.type === "context") {
      return (
        <span className="align-baseline font-medium !text-primary select-none">
          <MessageSquare className="mr-1 inline-block size-3.5 align-middle" />
          <span>{this.__item.displayName}</span>
        </span>
      )
    }
    return (
      <span className="align-baseline font-medium text-primary">
        {this.__item.displayName ?? this.__item.name}
      </span>
    )
  }
}
