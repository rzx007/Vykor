import { formatValue } from "../models/message-render-model"

const outputClassName = "px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap"

/** Keep content blocks in their original order, including unfamiliar resource types. */
export function ToolResult({
  output,
  calling,
  showRaw = true,
}: {
  output: unknown
  calling: boolean
  showRaw?: boolean
}) {
  if (output === undefined)
    return (
      <p className="px-3 py-2 text-xs text-ui-muted">
        {calling ? "等待工具返回结果" : "没有记录结果"}
      </p>
    )
  const content =
    output && typeof output === "object" && "content" in output ? output.content : undefined
  const blocks = Array.isArray(content) && content.length ? content : [output]
  return (
    <>
      <div className="max-h-56 overflow-auto">
        {blocks.map((block, index) => (
          <pre key={index} data-tool-output className={outputClassName}>
            {block &&
            typeof block === "object" &&
            block.type === "text" &&
            typeof block.text === "string"
              ? block.text
              : formatValue(block)}
          </pre>
        ))}
      </div>
      {showRaw && typeof output === "object" && output !== null ? (
        <details className="border-t text-xs text-ui-muted">
          <summary className="cursor-pointer px-3 py-2 focus-visible:outline-ring">
            原始详情
          </summary>
          <pre className={`max-h-56 overflow-auto ${outputClassName}`}>{formatValue(output)}</pre>
        </details>
      ) : null}
    </>
  )
}
