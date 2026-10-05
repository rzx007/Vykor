import type { ReactNode } from "react"

/** 展示与授权方式分开，后续 IM 可以复用同一行并提供自己的操作。 */
export function ConnectionChannelRow({
  id,
  name,
  icon,
  description,
  status,
  actions,
  children,
}: {
  id: string
  name: string
  icon: ReactNode
  description: ReactNode
  status?: ReactNode
  actions: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <article aria-labelledby={id + "-connection-name"}>
      <div className="flex min-h-20 flex-wrap items-center gap-3 py-4 sm:gap-4">
        <span className="grid size-10 shrink-0 place-items-center" aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-40 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h3 id={id + "-connection-name"} className="text-sm font-semibold">
              {name}
            </h3>
            {status}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      {children}
    </article>
  )
}

export function FeishuConnectionIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="size-10" viewBox="0 0 40 40" fill="none">
      <path d="m9 9 12 5 8-3-9 10Z" fill="#247cf4" />
      <path d="m9 17 11 4 10-5-6 15-9-4Z" fill="#00b5bc" />
      <path d="m20 21 10-5-6 15-3-6Z" fill="#397af6" />
    </svg>
  )
}
