import { useId, type ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@renderer/components/ui/card"
import { cn } from "@renderer/lib/utils"
import { ChevronDown } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"

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
        <CardContent className={cn("px-5", separated ? "divide-y divide-border" : "py-4")}>
          {children}
        </CardContent>
      </Card>
    </section>
  )
}

export function SettingsFoldout({
  title,
  children,
  id,
}: {
  title: string
  children: ReactNode
  id?: string
}) {
  return (
    <details id={id} className="group">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {title}
        <ChevronDown
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className="mt-3 flex flex-col gap-5">{children}</div>
    </details>
  )
}

export function SettingsSelect({
  value,
  options,
  onChange,
  disabled,
  label,
  id,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange(value: string): void
  disabled?: boolean
  label: string
  id?: string
}) {
  // 保留失效的当前选项，避免组件自动切到其他作用范围。
  const items = options.some((option) => option.value === value)
    ? options
    : [...options, { value, label: "选项不可用" }]
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null && options.some((option) => option.value === next)) onChange(next)
      }}
    >
      <SelectTrigger id={id} aria-label={label} disabled={disabled} className="w-56 max-w-full">
        <SelectValue>
          {options.find((option) => option.value === value)?.label ?? "选项不可用"}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={!options.some((available) => available.value === option.value)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
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
