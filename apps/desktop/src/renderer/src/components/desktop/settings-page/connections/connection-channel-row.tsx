import type { ReactNode } from "react"
import feishuLogoUrl from "@renderer/assets/feishu.svg"

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
      <div className="flex min-h-18 flex-wrap items-center gap-3 py-3.5 sm:gap-4">
        <span className="grid size-10 shrink-0 place-items-center" aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-40 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={id + "-connection-name"} className="text-sm font-semibold">
              {name}
            </h3>
            {status}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
      </div>
      {children}
    </article>
  )
}

export function FeishuConnectionIcon(): React.JSX.Element {
  return <img src={feishuLogoUrl} alt="" data-channel-logo="feishu" className="size-9" />
}
