import type { LucideIcon } from "lucide-react"
import type * as React from "react"

import { DesktopEmptyState } from "@renderer/components/desktop/shared/desktop-empty-state"

type PlaceholderToolProps = {
  icon: LucideIcon
  title: string
  description: string
  footer?: string
}

export function PlaceholderTool({
  icon,
  title,
  description,
  footer,
}: PlaceholderToolProps): React.JSX.Element {
  return (
    <section className="flex h-full min-h-0 flex-col">
      <DesktopEmptyState icon={icon} title={title} description={description} />
      {footer && (
        <div className="border-t bg-muted/35 px-4 py-3 font-mono text-xs text-ui-muted">
          {footer}
        </div>
      )}
    </section>
  )
}
