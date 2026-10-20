import { Braces, Globe, Mail, FolderOpen, Plug, Database } from "lucide-react"
import Github from "@lobehub/icons/es/Github/components/Mono"
import Figma from "@lobehub/icons/es/Figma/components/Color"
import Notion from "@lobehub/icons/es/Notion/components/Mono"
import Google from "@lobehub/icons/es/Google/components/Color"
import { useEffect, useState } from "react"
import { isPluginIconSource, isPluginWebUrl } from "@vykor/client"
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
