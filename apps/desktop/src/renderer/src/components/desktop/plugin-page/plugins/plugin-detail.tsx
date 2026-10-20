import { useRef, useState } from "react"
import { ArrowLeft, ArrowRight, ExternalLink, MessageCircle, Settings2 } from "lucide-react"
import { cjk } from "@streamdown/cjk"
import { Streamdown } from "streamdown"
import { isPluginWebUrl } from "@vykor/client"
import { Button } from "@renderer/components/ui/button"
import { toast } from "@renderer/lib/toast"
import type { DesktopPluginInfo } from "@shared/plugin-types"
import { ExtensionIcon } from "../shared/plugin-catalog"
import { PluginPromptBackground } from "./plugin-prompt-background"
import "./plugin-detail.css"

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
    <section
      aria-label={`${name} 插件详情`}
      className="mx-auto flex w-full max-w-[56rem] flex-col gap-8"
    >
      <Button
        variant="ghost"
        size="sm"
        shape="pill"
        className="-ml-2 self-start text-muted-foreground"
        onClick={onBack}
      >
        <ArrowLeft data-icon="inline-start" />
        返回插件
      </Button>
      <header className="flex flex-col gap-5">
        <ExtensionIcon name={name} src={presentation?.icon} size="lg" />
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold break-words">{name}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" shape="pill" onClick={onManage}>
              <Settings2 data-icon="inline-start" />
              管理
            </Button>
            <Button shape="pill" disabled={!usable || starting} onClick={() => void start()}>
              <MessageCircle data-icon="inline-start" />
              {starting ? "正在打开…" : "立即使用"}
            </Button>
          </div>
        </div>
        {presentation?.description ? (
          <p className="-mt-2 text-sm leading-6 text-muted-foreground">
            {presentation.description}
          </p>
        ) : null}
        {!usable ? (
          <p className="text-xs text-muted-foreground">
            {plugin.runtimeStatus.message} 请在管理中检查插件状态。
          </p>
        ) : null}
      </header>
      {presentation?.prompts?.length ? (
        <section
          aria-labelledby="plugin-prompts-title"
          className="relative isolate overflow-hidden rounded-2xl px-5 py-8 sm:px-10 sm:py-9"
        >
          <h2 id="plugin-prompts-title" className="sr-only">
            快速使用
          </h2>
          <PluginPromptBackground />
          <div className="relative mx-auto flex w-full max-w-[34rem] flex-col gap-4">
            {presentation.prompts.map((item, index) => (
              <Button
                key={index}
                variant="ghost"
                disabled={!usable || starting}
                aria-label={`使用示例：${item.title}`}
                onClick={() => void start(item.prompt)}
                title={item.title}
                className="plugin-prompt-example h-auto min-h-16 w-full justify-between gap-4 rounded-2xl border-0 px-3 py-3 text-left whitespace-normal active:translate-y-0"
              >
                <span className="min-w-0 text-sm leading-6 font-normal break-words">
                  <span className="mr-1 inline-flex items-center gap-1 align-middle font-medium">
                    <ExtensionIcon name={name} src={presentation.icon} size="inline" />
                    {name}
                  </span>
                  {item.prompt}
                </span>
                <span
                  aria-hidden="true"
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/8"
                >
                  <ArrowRight className="size-4" />
                </span>
              </Button>
            ))}
          </div>
        </section>
      ) : null}
      <section aria-labelledby="plugin-introduction-title" className="flex flex-col gap-3">
        <h2 id="plugin-introduction-title" className="sr-only">
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
        <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-8 gap-y-3 text-sm sm:grid-cols-[7rem_minmax(0,1fr)] [&>dd]:min-w-0 [&>dd]:break-words">
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
