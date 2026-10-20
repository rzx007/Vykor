import { Box } from "lucide-react"
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode } from "lexical"

export interface SerializedSkillMentionNode {
  type: "skill-mention"
  version: 1
  name: string
  path: string
  displayName: string
  source: string
}

type SerializedSkillMentionPayload = SerializedLexicalNode & Record<string, unknown>

export class SkillMentionNode extends DecoratorNode<React.JSX.Element> {
  __name: string
  __path: string
  __displayName: string
  __source: string

  static getType(): string {
    return "skill-mention"
  }

  static clone(node: SkillMentionNode): SkillMentionNode {
    return new SkillMentionNode(
      node.__name,
      node.__path,
      node.__displayName,
      node.__source,
      node.__key
    )
  }

  static importJSON(serializedNode: SerializedSkillMentionPayload): SkillMentionNode {
    return $createSkillMentionNode(
      typeof serializedNode.name === "string" ? serializedNode.name : "skill",
      typeof serializedNode.path === "string" ? serializedNode.path : "",
      typeof serializedNode.displayName === "string" ? serializedNode.displayName : "skill",
      typeof serializedNode.source === "string" ? serializedNode.source : "unknown"
    )
  }

  constructor(name: string, path: string, displayName: string, source: string, key?: NodeKey) {
    super(key)
    this.__name = name
    this.__path = path
    this.__displayName = displayName
    this.__source = source
  }

  exportJSON(): SerializedSkillMentionNode {
    return {
      type: "skill-mention",
      version: 1,
      name: this.__name,
      path: this.__path,
      displayName: this.__displayName,
      source: this.__source,
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

  getTextContent(): string {
    return `$${this.__name}`
  }

  isKeyboardSelectable(): boolean {
    return false
  }

  decorate(): React.JSX.Element {
    return (
      <span className="align-baseline font-medium !text-primary select-none">
        <Box className="mr-1 inline-block size-3.5 align-middle" />
        <span>{this.__displayName}</span>
      </span>
    )
  }
}

export function $createSkillMentionNode(
  name: string,
  path: string,
  displayName: string,
  source: string
): SkillMentionNode {
  return new SkillMentionNode(name, path, displayName, source)
}

export function $isSkillMentionNode(
  node: LexicalNode | null | undefined
): node is SkillMentionNode {
  return node instanceof SkillMentionNode
}
