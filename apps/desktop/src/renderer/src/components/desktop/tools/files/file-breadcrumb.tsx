import type * as React from "react"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@renderer/components/motion/breadcrumb"
import { cn } from "@renderer/lib/utils"
import type { WorkspaceReadFileResult } from "@shared/workspace-types"

export function FileBreadcrumb({
  projectName,
  path,
  scope,
  rootLabel,
}: {
  projectName: string
  path: string
  scope?: WorkspaceReadFileResult["scope"]
  rootLabel?: string
}): React.JSX.Element {
  const rootName = scope === "extra-root" && rootLabel ? rootLabel : projectName
  const normalizedPath = path.trim() || "/"
  const segments = normalizedPath === "/" ? [] : normalizedPath.split("/").filter(Boolean)
  const labels = [rootName, ...(segments.length === 0 ? ["/"] : segments)]

  return (
    <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
      <BreadcrumbList
        maxItems={4}
        overflowLabel="显示被折叠的路径"
        className="text-ui-small flex-nowrap"
      >
        {labels.map((label, index) => {
          const last = index === labels.length - 1
          const isRoot = index === 0
          const key = isRoot ? "root" : `${label}-${index}`
          return (
            <BreadcrumbItem key={key}>
              {index > 0 && <BreadcrumbSeparator className="text-ui-muted/70" />}
              {last ? (
                <BreadcrumbPage
                  title={label}
                  className="text-ui-small font-semibold text-ui-foreground"
                >
                  {label}
                </BreadcrumbPage>
              ) : (
                <BreadcrumbLink
                  tabIndex={-1}
                  title={label}
                  className={cn(
                    "text-ui-small text-ui-muted hover:bg-transparent",
                    isRoot && "max-w-40 shrink-0"
                  )}
                >
                  <span className="truncate">{label}</span>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
