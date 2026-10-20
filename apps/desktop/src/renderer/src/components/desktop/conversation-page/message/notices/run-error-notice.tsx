import { AlertCircle, ChevronRight } from "lucide-react"
import { useState } from "react"

const leadingHttpReasonPhrases: Partial<Record<number, readonly string[]>> = {
  400: ["bad request"],
  401: ["unauthorized"],
  402: ["payment required"],
  403: ["forbidden"],
  404: ["not found"],
  408: ["request timeout"],
  409: ["conflict"],
  413: ["content too large", "payload too large", "request entity too large"],
  422: ["unprocessable content", "unprocessable entity"],
  429: ["rate limit", "rate limited", "too many requests"],
  500: ["internal server error"],
  501: ["not implemented"],
  502: ["bad gateway"],
  503: ["service unavailable"],
  504: ["gateway timeout"],
  505: ["http version not supported"],
  506: ["variant also negotiates"],
  507: ["insufficient storage"],
  508: ["loop detected"],
  510: ["not extended"],
  511: ["network authentication required"],
}

export function RunErrorNotice({ error }: { error?: string }): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState<{ error?: string } | null>(null)
  if (dismissed?.error === error && dismissed !== null) return null
  const detail = error?.trim()
  const statusMessage = detail
    ? (runFailureGuidance(detail) ?? "这次请求没有完成")
    : "这次请求没有完成，暂时没有更多错误信息。"
  const statusRow = (
    <>
      <AlertCircle className="mr-2 inline-block size-4 align-[-0.2em] text-amber-600/80 dark:text-amber-400/80" />
      <span className="font-medium">{statusMessage}</span>
      {detail ? (
        <span
          data-run-error-detail-control
          className="ml-2 inline-flex items-center gap-1 whitespace-nowrap text-ui-muted"
        >
          详情
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
        </span>
      ) : null}
    </>
  )

  return (
    <section
      data-run-error-notice
      aria-label="请求未完成"
      className="flex max-w-xl items-start gap-2 text-xs text-foreground/80"
    >
      {detail ? (
        <details className="group">
          <summary
            data-run-error-status-row
            aria-live="polite"
            aria-atomic="true"
            className="w-fit cursor-pointer list-none rounded-md py-1.5 pr-1 leading-5 select-none hover:text-foreground [&::-webkit-details-marker]:hidden"
          >
            {statusRow}
          </summary>
          <pre className="text-ui-caption mt-1 ml-6 max-h-40 overflow-auto rounded-lg bg-muted/40 px-3 py-2 leading-relaxed whitespace-pre-wrap text-ui-muted">
            {detail}
          </pre>
        </details>
      ) : (
        <div
          data-run-error-status-row
          aria-live="polite"
          aria-atomic="true"
          className="w-fit py-1.5 leading-5"
        >
          {statusRow}
        </div>
      )}
      <button
        type="button"
        aria-label="关闭运行错误"
        className="shrink-0 rounded py-1.5 leading-5 text-ui-muted underline hover:text-foreground"
        onClick={() => setDismissed({ error })}
      >
        关闭
      </button>
    </section>
  )
}

function runFailureGuidance(error: string): string | null {
  if (
    error.includes("not supported when using Codex") ||
    error.includes("supported API model names")
  ) {
    return "当前模型与供应商不匹配，请在输入框右下角重新选择模型。"
  }

  const status = httpStatusFromError(error)
  if (status === 400) return "请求参数错误，请检查输入内容或附件后再试。"
  if (status === 401) return "身份验证未通过，请检查登录状态或 API 密钥。"
  if (status === 402) return "账户余额或订阅状态异常，请检查账单设置。"
  if (status === 403) return "当前账号无权使用该模型或服务，请检查权限配置。"
  if (status === 404) return "未找到对应的模型或服务接口，请检查模型与服务地址。"
  if (status === 408) return "请求等待时间过长，请稍后再试。"
  if (status === 409) return "请求状态发生冲突，请稍后再试。"
  if (status === 413) return "请求内容过大，请减少附件或上下文后再试。"
  if (status === 422) return "服务无法处理当前参数，请检查输入或模型配置。"
  if (status === 429) return "请求过于频繁或额度受限，请稍后再试。"
  if (status === 501) return "当前服务不支持这项请求，请检查模型或服务配置。"
  if (status === 511) return "网络访问需要额外身份验证，请检查网络或代理设置。"
  if (status !== null && status >= 500 && status <= 599) {
    return [500, 502, 503, 504, 529].includes(status)
      ? "服务暂时不可用，请稍后再试。"
      : "服务返回异常，请展开详情了解原因。"
  }
  return null
}

function httpStatusFromError(error: string): number | null {
  const patterns = [
    /\bhttp\s*error\s*[:=]?\s*([1-5]\d{2})\b/i,
    /\bhttp(?:\/\d+(?:\.\d+)?)?\s*[:=]?\s*([1-5]\d{2})\b/i,
    /\bhttp\s+status(?:\s+code)?\s*[:=]?\s*([1-5]\d{2})\b/i,
    /\b(?:response|request)\b[^\r\n]{0,50}\b(?:status(?:\s+code)?["']?|code)\s*[:=]?\s*([1-5]\d{2})\b/i,
    /^\s*([1-5]\d{2})\s+status\s+code\b/i,
  ]
  for (const pattern of patterns) {
    const match = error.match(pattern)
    if (match?.[1]) return Number(match[1])
  }

  const leadingStatus = error.match(/^\s*([45]\d{2})\s+([^\r\n]+)/)
  if (!leadingStatus?.[1] || !leadingStatus[2]) return null
  const status = Number(leadingStatus[1])
  const reason = leadingStatus[2].trim().toLocaleLowerCase()
  if (leadingHttpReasonPhrases[status]?.some((phrase) => reason.startsWith(phrase))) return status
  return null
}
