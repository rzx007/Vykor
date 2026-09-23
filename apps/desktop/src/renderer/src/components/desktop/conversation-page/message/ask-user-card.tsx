import ApprovalCard, {
  type ApprovalAnswers,
  type ApprovalQuestion,
} from "@renderer/components/ui/approval-card"

import type { DesktopPermissionRequest } from "@shared/session-types"

function questionPayload(permission: DesktopPermissionRequest): ApprovalQuestion[] {
  const input = permission.payload.input

  const questions =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).questions
      : undefined

  if (Array.isArray(questions)) {
    const parsed = questions.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return []

      const record = item as Record<string, unknown>

      const text = typeof record.question === "string" ? record.question.trim() : ""

      if (!text) return []

      const options = Array.isArray(record.options)
        ? record.options.filter((option): option is string => typeof option === "string")
        : []

      const type = record.type === "check" ? ("check" as const) : ("radio" as const)

      return [{ q: text, type: options.length > 0 ? type : ("check" as const), options }]
    })

    if (parsed.length > 0) return parsed
  }

  const question =
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    typeof (input as Record<string, unknown>).question === "string"
      ? String((input as Record<string, unknown>).question)
      : typeof permission.payload.reason === "string"
        ? permission.payload.reason
        : "请回答这个问题"

  return [{ q: question, type: "check", options: [] }]
}

export function AskUserCard({
  permission,

  replyPending = false,

  replyError = null,

  onReply,
}: {
  permission: DesktopPermissionRequest

  replyPending?: boolean

  replyError?: string | null

  onReply: (answer: string) => void
}): React.JSX.Element {
  return (
    <section className="mt-0">
      {replyError ? (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {replyError}
        </p>
      ) : null}

      <div className={replyPending ? "pointer-events-none opacity-65" : undefined}>
        <ApprovalCard
          questions={questionPayload(permission)}

          labels={{
            skip: "跳过",

            continue: "继续",

            send: "提交",

            customPlaceholder: "输入其他答案…",

            sentMessage: "答案已提交",
          }}

          onSubmitted={({ selected, custom }: ApprovalAnswers) => {
            onReply(JSON.stringify({ selected, custom }))
          }}

          resettable={false}
          dismissible={false}
        />
      </div>
    </section>
  )
}
