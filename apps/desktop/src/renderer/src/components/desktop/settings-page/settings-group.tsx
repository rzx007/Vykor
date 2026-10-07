import { useId, type ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@renderer/components/ui/card"
import { cn } from "@renderer/lib/utils"

export function SettingsGroup({
  title,
  id,
  action,
  description,
  separated = false,
  "data-setting-id": settingId,
  children,
}: {
  title: string
  id?: string
  action?: ReactNode
  description?: string
  separated?: boolean
  "data-setting-id"?: string
  children: ReactNode
}) {
  const generatedId = useId()
  const headingId = id ?? generatedId
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby={headingId}
      data-setting-id={settingId}
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id={headingId} className="text-[15px] font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {description ? (
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      ) : null}
      <Card className="gap-0 py-0">
        <CardHeader className="sr-only" aria-hidden="true">
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className={cn("px-5", separated && "divide-y divide-border")}>
          {children}
        </CardContent>
      </Card>
    </section>
  )
}

export function SettingsRow({
  title,
  description,
  control,
  labelFor,
}: {
  title: string
  description?: string
  control: ReactNode
  labelFor?: string
}) {
  return (
    <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-6 gap-y-3 py-3">
      <div className="min-w-44 flex-1">
        {labelFor ? (
          <label htmlFor={labelFor} className="text-sm font-medium">
            {title}
          </label>
        ) : (
          <h3 className="text-sm font-medium">{title}</h3>
        )}
        {description ? (
          <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="max-w-full shrink-0">{control}</div>
    </div>
  )
}
