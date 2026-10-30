import {
  formatValue,
  toolDisplayName,
  toolCallStatus,
  type AssistantContentUnit,
} from "../models/message-render-model"
import { useToolDetails } from "./use-tool-details"
import { ReadImagePreview, readImagePath } from "../attachments/read-image-preview"
import { ShellToolDetails } from "./shell-tool-details"
import { ToolResult } from "./tool-result"

type ToolUnit = Extract<AssistantContentUnit, { type: "tool" }>
export function ToolDetails({
  tool,
  calling,
}: {
  tool: ToolUnit
  calling: boolean
}): React.JSX.Element {
  const { call, result } = tool
  const { call: fullCall, result: fullResult, preview, error } = useToolDetails(call, result, true)
  const input = fullCall.input
  const output = fullResult?.output ?? fullCall.output
  const unparsedInput = Boolean(
    (fullResult?.metadata.toolInputError ?? fullCall.metadata.toolInputError) &&
    (input === undefined || Object.keys(input).length === 0)
  )
  const imagePath = readImagePath(fullCall)
  const imagePart = fullResult?.output != null ? fullResult : fullCall
  return (
    <>
      {imagePath ? <ReadImagePreview part={imagePart} path={imagePath} calling={calling} /> : null}
      <div className="border-b px-3 py-1.5 text-xs">{toolDisplayName(call, result)}</div>
      {preview ? (
        <p role="status" className="px-3 py-2 text-xs text-ui-muted">
          {error ?? "正在加载完整详情；当前仅显示预览。"}
        </p>
      ) : null}
      {imagePath && toolCallStatus(fullCall, fullResult) === "completed" ? null : call.toolName ===
          "Shell" || call.toolName === "Bash" ? (
        <ShellToolDetails
          input={input}
          output={output}
          calling={calling}
          unparsedInput={unparsedInput}
        />
      ) : (
        <>
          <div className="px-3 pt-2 text-xs font-medium">参数</div>
          {unparsedInput ? (
            <p className="px-3 py-2 text-xs text-ui-muted">
              {import.meta.env.DEV
                ? "参数解析失败，请查看下方错误结果。"
                : "没有记录可展示的参数。"}
            </p>
          ) : input === undefined ? (
            <p className="px-3 py-2 text-xs text-ui-muted">参数尚未提供</p>
          ) : (
            <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">
              {formatValue(input)}
            </pre>
          )}
          <div className="border-t px-3 pt-2 text-xs font-medium">结果</div>
          <ToolResult output={output} calling={calling} />
        </>
      )}
      {preview && fullCall.bodyView?.outputReferences?.length ? (
        <p className="px-3 py-2 text-xs text-ui-muted">
          {fullCall.bodyView.outputReferences.join("\n")}
        </p>
      ) : null}
    </>
  )
}
