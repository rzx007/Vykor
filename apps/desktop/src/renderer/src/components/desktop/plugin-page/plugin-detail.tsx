import { useRef, useState } from "react"
import { ArrowLeft, ArrowRight, ExternalLink, MessageCircle, Settings2 } from "lucide-react"
import { cjk } from "@streamdown/cjk"
import { Streamdown } from "streamdown"
import { isPluginWebUrl } from "@vykor/client"
import { Button } from "@renderer/components/ui/button"
import { toast } from "@renderer/lib/toast"
import type { DesktopPluginInfo } from "@shared/plugin-types"
import { ExtensionIcon } from "./plugin-catalog"

export function PluginDetail({
  plugin,
  onBack,
  onManage,
  onUse,
}: {
  plugin: DesktopPluginInfo
  onBack: () => void
  onManage: () => void
  onUse?: (plugin: DesktopPluginInfo, prompt: string) => Promise<void>
}): React.JSX.Element {
  const [starting, setStarting] = useState(false)
  const lock = useRef(false)
  const name = plugin.identity.displayName ?? plugin.identity.name
  const presentation = plugin.presentation
  const usable = Boolean(
    onUse &&
    plugin.enabled &&
    plugin.installation === "installed" &&
    plugin.permissions.missing.length === 0 &&
    plugin.runtimeStatus.state !== "failed"
  )
  const start = async (prompt = ""): Promise<void> => {
    if (!usable || !onUse || lock.current) return
    lock.current = true
    setStarting(true)
    try {
      await onUse(plugin, prompt)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      lock.current = false
      setStarting(false)
    }
  }
  return (
    <section aria-label={`${name} 插件详情`} className="flex flex-col gap-8">
      <Button variant="ghost" shape="pill" className="self-start" onClick={onBack}>
        <ArrowLeft data-icon="inline-start" />
        返回插件
      </Button>
      <header className="flex flex-col gap-4">
        <ExtensionIcon name={name} src={presentation?.icon} size="lg" />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold break-words">{name}</h1>
            {presentation?.description ? (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {presentation.description}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" shape="pill" onClick={onManage}>
              <Settings2 data-icon="inline-start" />
              管理
            </Button>
            <Button shape="pill" disabled={!usable || starting} onClick={() => void start()}>
              <MessageCircle data-icon="inline-start" />
              {starting ? "正在打开…" : "立即使用"}
            </Button>
          </div>
        </div>
        {!usable ? (
          <p className="text-xs text-muted-foreground">
            {plugin.runtimeStatus.message} 请在管理中检查插件状态。
          </p>
        ) : null}
      </header>
      {presentation?.prompts?.length ? (
        <section aria-labelledby="plugin-prompts-title" className="flex flex-col gap-3">
          <h2 id="plugin-prompts-title" className="text-[15px] font-semibold">
            快速使用
          </h2>
          <div className="flex flex-col gap-2 rounded-2xl bg-muted/40 p-4 sm:p-6">
            {presentation.prompts.map((item, index) => (
              <Button
                key={index}
                variant="ghost"
                disabled={!usable || starting}
                aria-label={`使用示例：${item.title}`}
                onClick={() => void start(item.prompt)}
                className="h-auto min-h-14 w-full justify-between gap-4 rounded-xl bg-background px-4 py-3 text-left whitespace-normal"
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium">{item.title}</span>
                  <span className="text-xs leading-5 font-normal break-words text-muted-foreground">
                    {item.prompt}
                  </span>
                </span>
                <ArrowRight className="shrink-0" />
              </Button>
            ))}
          </div>
        </section>
      ) : null}
      <section aria-labelledby="plugin-introduction-title" className="flex flex-col gap-3">
        <h2 id="plugin-introduction-title" className="text-[15px] font-semibold">
          插件介绍
        </h2>
        {presentation?.introduction || presentation?.description ? (
          <article className="desktop-markdown-preview text-sm leading-7">
            <Streamdown
              mode="static"
              controls={false}
              plugins={{ cjk }}
              className="desktop-streamdown"
            >
              {presentation.introduction || presentation.description || ""}
            </Streamdown>
          </article>
        ) : (
          <p className="text-sm text-muted-foreground">作者暂未提供插件介绍。</p>
        )}
      </section>
      <section aria-labelledby="plugin-information-title" className="flex flex-col gap-4">
        <h2
          id="plugin-information-title"
          className="border-b border-border/60 pb-3 text-[15px] font-semibold"
        >
          信息
        </h2>
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">版本</dt>
          <dd>{plugin.identity.version}</dd>
          {presentation?.author ? (
            <>
              <dt className="text-muted-foreground">开发者</dt>
              <dd>{presentation.author.name}</dd>
            </>
          ) : null}
          {presentation?.keywords?.length ? (
            <>
              <dt className="text-muted-foreground">标签</dt>
              <dd>{presentation.keywords.join("、")}</dd>
            </>
          ) : null}
          {presentation?.license ? (
            <>
              <dt className="text-muted-foreground">许可证</dt>
              <dd>{presentation.license}</dd>
            </>
          ) : null}
          {[
            ["网站", presentation?.homepage],
            ["源码", presentation?.repository],
          ].map(([label, url]) =>
            url && isPluginWebUrl(url) ? (
              <ExternalInfo key={label} label={label!} url={url} />
            ) : null
          )}
        </dl>
      </section>
    </section>
  )
}

function ExternalInfo({ label, url }: { label: string; url: string }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto max-w-full justify-start px-0 text-sm"
          aria-label={`打开插件${label}`}
          onClick={() =>
            void window.desktop.window
              .openExternal(url)
              .catch(() => toast.error("链接打开失败，请稍后重试。"))
          }
        >
          <span className="truncate">{new URL(url).hostname}</span>
          <ExternalLink data-icon="inline-end" />
        </Button>
      </dd>
    </>
  )
}
