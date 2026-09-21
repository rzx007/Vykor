import { describe, expect, it, vi } from "vitest"
import type { ReactElement } from "react"

vi.mock("streamdown", () => ({
  useIsCodeFenceIncomplete: () => false,
}))

import { CodeBlock } from "@renderer/components/ui/code-block"

import { createStreamdownComponents } from "../streamdown-components"
import { FileButton, StreamdownCodeBlock } from "../streamdown-renderers"

describe("streamdown file references", () => {
  it("renders explicit file links as buttons but keeps inline code as code", () => {
    const components = createStreamdownComponents({ onOpenFile: vi.fn() })
    const anchor = components.a as (props: { href: string; children: string }) => ReactElement
    const inlineCode = components.inlineCode as (props: { children: string }) => ReactElement
    const link = anchor({ href: "src/index.ts:42", children: "entry" })
    const inline = inlineCode({ children: "src/index.ts:42" })

    expect(link).toMatchObject({ type: FileButton, props: { path: "src/index.ts", line: 42 } })
    expect(inline).toMatchObject({ type: "code" })
  })
})

describe("StreamdownCodeBlock", () => {
  it("routes a non-Mermaid fence to CodeBlock with its source and language", () => {
    const code = "const answer = 42\n"

    const rendered = StreamdownCodeBlock({
      className: "language-typescript",
      children: code,
    })

    expect(rendered.type).toBe(CodeBlock)
    expect(rendered.props).toMatchObject({
      className: "my-4",
      code: "const answer = 42",
      language: "typescript",
      filename: "typescript",
      showLineNumbers: false,
    })
  })
})

describe("FileButton", () => {
  it("renders file link with extension badge and text-file-link class", () => {
    const onOpenFile = vi.fn()
    const rendered = FileButton({
      path: "src/index.tsx",
      line: 42,
      onOpenFile,
      children: "src/index.tsx:42",
    })

    expect(rendered.props.className).toContain("assistant-file-link")
    expect(rendered.props.className).toContain("assistant-file-link-source")
    expect(rendered.props.title).toBe("打开 src/index.tsx")

    const [icon, label] = rendered.props.children
    expect(icon.props.path).toBe("src/index.tsx")
    expect(label.props.className).toContain("text-file-link")
    expect(label.props.children).toBe("src/index.tsx:42")

    rendered.props.onClick()
    expect(onOpenFile).toHaveBeenCalledWith("src/index.tsx", 42)
  })

  it("renders default FileCode2 icon with text-file-link when extension is unknown", () => {
    const onOpenFile = vi.fn()
    const rendered = FileButton({
      path: "notes.unknown",
      onOpenFile,
      children: "notes.unknown",
    })

    const [icon] = rendered.props.children
    const iconElement = icon.type({ path: "notes.unknown" })
    expect(iconElement.props.className).toContain("text-file-link")
  })
})
