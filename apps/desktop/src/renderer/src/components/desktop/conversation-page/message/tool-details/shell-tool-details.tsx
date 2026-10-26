import { formatValue } from "../models/message-render-model"
import { ToolResult } from "./tool-result"

export function ShellToolDetails({
  input,
  output,
  calling,
  unparsedInput,
}: {
  input: unknown
  output: unknown
  calling: boolean
  unparsedInput: boolean
}): React.JSX.Element {
  const command = shellCommandText(input)

  return (
    <>
      <div className="px-3 pt-2 text-xs font-medium">命令</div>
      {unparsedInput ? (
        <p className="px-3 py-2 text-xs text-ui-muted">
          {import.meta.env.DEV ? "参数解析失败，请查看下方错误结果。" : "没有记录可展示的参数。"}
        </p>
      ) : command !== undefined ? (
        <pre
          data-shell-command
          className="px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap"
        >
          {command}
        </pre>
      ) : input === undefined ? (
        <p className="px-3 py-2 text-xs text-ui-muted">命令尚未提供</p>
      ) : (
        <pre className="px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
          {formatValue(input)}
        </pre>
      )}
      <div className="border-t px-3 pt-2 text-xs font-medium">输出</div>
      {output === undefined ? (
        <p className="px-3 py-2 text-xs text-ui-muted">
          {calling ? "等待工具返回结果" : "没有记录结果"}
        </p>
      ) : (
        <div data-shell-output className="max-h-56 overflow-auto">
          <ToolResult output={output} calling={calling} showRaw={false} />
        </div>
      )}
    </>
  )
}

function shellCommandText(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const command = "command" in input ? input.command : undefined
  if (typeof command === "string") return command
  const args = "arguments" in input ? input.arguments : undefined
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
  const nestedCommand = "command" in args ? args.command : undefined
  return typeof nestedCommand === "string" ? nestedCommand : undefined
}
