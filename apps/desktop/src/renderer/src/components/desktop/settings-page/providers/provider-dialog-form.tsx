import { LoaderCircle } from "lucide-react"
import { useId, useRef, type FormEventHandler, type ReactNode } from "react"

import { Input } from "@renderer/components/motion/input"
import { Button } from "@renderer/components/ui/button"
import {
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Field, FieldLabel } from "@renderer/components/ui/field"
import { cn } from "@renderer/lib/utils"

export function ProviderDialogForm({
  title,
  busy,
  submitLabel,
  canSubmit = true,
  hasNewKey,
  wide,
  onSubmit,
  children,
}: {
  title: string
  busy: boolean
  submitLabel: string
  canSubmit?: boolean
  hasNewKey: boolean
  wide?: boolean
  onSubmit: FormEventHandler<HTMLFormElement>
  children: ReactNode
}): React.JSX.Element {
  const costHintId = useId()
  return (
    <DialogContent
      showCloseButton={!busy}
      className={cn(
        "overflow-hidden p-0 [&>[data-slot=dialog-close]]:rounded-full",
        wide && "sm:max-w-2xl"
      )}
    >
      <form onSubmit={onSubmit} className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <DialogHeader className="shrink-0 px-5 pt-5 pr-12 pb-3">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="@container/provider-form min-h-0 overflow-y-auto px-5 pt-1 pb-5">
          {children}
        </div>
        <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t px-5 py-3">
          {hasNewKey && (
            <p id={costHintId} className="mr-auto text-xs text-muted-foreground">
              验证新密钥可能产生费用。
            </p>
          )}
          <div className="ml-auto flex items-center gap-2">
            <DialogClose
              render={
                <Button type="button" variant="outline" shape="pill" disabled={busy}>
                  取消
                </Button>
              }
            />
            <Button
              type="submit"
              shape="pill"
              disabled={!canSubmit || busy}
              aria-describedby={hasNewKey ? costHintId : undefined}
            >
              {busy && <LoaderCircle data-icon="inline-start" className="animate-spin" />}
              {busy ? "保存中..." : submitLabel}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

const SAVED_CREDENTIAL_MASK = "••••••••••••"

export function ProviderApiKeyField({
  id,
  value,
  saved,
  placeholder,
  optional = false,
  onReplace,
  onChange,
}: {
  id: string
  value: string
  saved: boolean
  placeholder: string
  optional?: boolean
  onReplace: () => void
  onChange: (value: string) => void
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  return (
    <Field className="gap-1.5">
      <FieldLabel htmlFor={id}>{optional ? "API 密钥（可选）" : "API 密钥"}</FieldLabel>
      <div className="flex min-w-0 items-start gap-2">
        <Input
          ref={input}
          id={id}
          className="min-w-0 flex-1"
          type={saved ? "text" : "password"}
          autoComplete="off"
          readOnly={saved}
          value={saved ? SAVED_CREDENTIAL_MASK : value}
          onChange={saved ? undefined : onChange}
          placeholder={placeholder}
        />
        {saved && (
          <Button
            type="button"
            variant="outline"
            shape="pill"
            onClick={() => {
              onReplace()
              input.current?.focus()
            }}
          >
            更换
          </Button>
        )}
      </div>
    </Field>
  )
}
