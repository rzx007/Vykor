import {
  Braces,
  Globe,
  Mail,
  FolderOpen,
  Plug,
  Database,
  NotebookPen,
  PencilRuler,
  TextSearch,
} from "lucide-react"
import Github from "@lobehub/icons/es/Github/components/Mono"
import Figma from "@lobehub/icons/es/Figma/components/Color"
import Notion from "@lobehub/icons/es/Notion/components/Mono"
import Google from "@lobehub/icons/es/Google/components/Color"
import { useEffect, useState } from "react"
import { isPluginIconSource, isPluginWebUrl } from "@rzx/client"
import { cn } from "@renderer/lib/utils"

export function ExtensionIcon({
  name,
  src,
  size = "md",
}: {
  name: string
  src?: string
  size?: "inline" | "sm" | "md" | "lg"
}): React.JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [remoteIcon, setRemoteIcon] = useState<{ src: string; value: string | null } | null>(null)
  const loadIcon = typeof window === "undefined" ? undefined : window.desktop?.plugins?.loadIcon
  useEffect(() => {
    if (!src || !isPluginWebUrl(src) || !loadIcon) return
    let current = true
    void loadIcon({ src })
      .then((value) => {
        if (current) setRemoteIcon({ src, value })
      })
      .catch(() => {
        if (current) setRemoteIcon({ src, value: null })
      })
    return () => {
      current = false
    }
  }, [src, loadIcon])
  const imageSrc =
    src && isPluginIconSource(src)
      ? isPluginWebUrl(src)
        ? remoteIcon?.src === src
          ? remoteIcon.value
          : null
        : src
      : null
  const normalized = name.toLowerCase()
  const icon = normalized.includes("github") ? (
    <Github size={25} />
  ) : normalized.includes("figma") ? (
    <Figma size={25} />
  ) : normalized.includes("notion") ? (
    <Notion size={25} />
  ) : normalized.includes("google") ? (
    <Google size={25} />
  ) : /excalidraw|canvas|画板/.test(normalized) ? (
    <PencilRuler className="size-6" />
  ) : /notes|笔记/.test(normalized) ? (
    <NotebookPen className="size-6" />
  ) : /inspector|文本检查/.test(normalized) ? (
    <TextSearch className="size-6" />
  ) : /mail|邮件/.test(normalized) ? (
    <Mail className="size-6" />
  ) : /browser|浏览/.test(normalized) ? (
    <Globe className="size-6" />
  ) : /files|文件/.test(normalized) ? (
    <FolderOpen className="size-6" />
  ) : /database|数据库/.test(normalized) ? (
    <Database className="size-6" />
  ) : /context|检索/.test(normalized) ? (
    <Braces className="size-6" />
  ) : (
    <Plug className="size-6" />
  )
  return (
    <span
      className={cn(
        size === "inline"
          ? "inline-grid size-4 shrink-0 place-items-center align-middle [&>svg]:size-4"
          : "grid shrink-0 place-items-center rounded-xl border border-border/60 bg-background",
        size === "lg"
          ? "size-16 p-2 [&>svg]:size-10"
          : size === "inline"
            ? ""
            : size === "sm"
              ? "size-6 p-0.5 [&>svg]:size-4"
              : "size-11 p-2"
      )}
      aria-hidden="true"
    >
      {imageSrc && imageSrc !== failedSrc ? (
        <img
          src={imageSrc}
          alt=""
          className="size-full object-contain"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(imageSrc)}
        />
      ) : (
        icon
      )}
    </span>
  )
}

export function ExtensionRow({
  name,
  icon,
  description,
  status,
  onClick,
  action,
}: {
  name: string
  icon?: string
  description?: string
  status?: string
  onClick: () => void
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-extension-row
      className="group flex min-h-20 min-w-0 items-center gap-3 rounded-xl px-1 py-3"
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`查看 ${name} 详情`}
        onClick={onClick}
      >
        <ExtensionIcon name={name} src={icon} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-semibold group-hover:underline group-hover:underline-offset-4">
            {name}
          </span>
          {description ? (
            <span className="truncate text-sm text-muted-foreground" title={description}>
              {description}
            </span>
          ) : null}
          {status ? <span className="truncate text-xs text-muted-foreground">{status}</span> : null}
        </span>
      </button>
      {action}
    </div>
  )
}
