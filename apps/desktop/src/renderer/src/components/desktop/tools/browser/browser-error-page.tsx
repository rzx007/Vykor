import {
  ArrowLeft,
  ArrowUpRight,
  CircleAlert,
  FileQuestion,
  Globe2,
  MonitorX,
  RefreshCw,
  ShieldAlert,
  WifiOff,
} from "lucide-react"
import { Button } from "@renderer/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@renderer/components/ui/empty"
import { displayFailureUrl, type BrowserLoadFailure } from "./browser-load-failure"

const icons = {
  file: FileQuestion,
  network: WifiOff,
  security: ShieldAlert,
  http: Globe2,
  crash: MonitorX,
  unknown: CircleAlert,
}

export function BrowserErrorPage({
  failure,
  canGoBack,
  onRetry,
  onBack,
  onShowOriginal,
}: {
  failure: BrowserLoadFailure
  canGoBack: boolean
  onRetry: () => void
  onBack: () => void
  onShowOriginal: () => void
}): React.JSX.Element {
  const Icon = icons[failure.kind]
  return (
    <section
      role="alert"
      aria-label="浏览器加载失败"
      className="absolute inset-0 z-10 overflow-y-auto bg-background text-foreground"
    >
      <Empty className="min-h-full rounded-none p-5 text-left @sm/browser:p-8">
        <div className="w-full max-w-lg min-w-0 space-y-5 py-4">
          <EmptyHeader className="max-w-none items-start gap-3 text-left">
            <EmptyMedia>
              <Icon className="size-9 text-muted-foreground" strokeWidth={1.75} />
            </EmptyMedia>
            <EmptyTitle
              role="heading"
              aria-level={2}
              className="text-xl font-semibold tracking-normal"
            >
              {failure.title}
            </EmptyTitle>
            <EmptyDescription className="text-sm leading-6">{failure.description}</EmptyDescription>
          </EmptyHeader>
          <div className="min-w-0 space-y-2">
            <p
              aria-label="加载失败的地址"
              className="rounded-xl bg-muted/50 px-3 py-2.5 text-xs leading-5 break-all whitespace-pre-wrap"
            >
              {displayFailureUrl(failure.url)}
            </p>
            <p className="font-mono text-xs leading-5 break-all text-muted-foreground">
              {failure.code}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="control"
              shape="pill"
              aria-label="重新加载页面"
              onClick={onRetry}
            >
              <RefreshCw data-icon="inline-start" />
              重新加载
            </Button>
            {canGoBack && (
              <Button
                type="button"
                variant="ghost"
                shape="pill"
                aria-label="返回上一页"
                onClick={onBack}
              >
                <ArrowLeft data-icon="inline-start" />
                返回上一页
              </Button>
            )}
            {failure.kind === "http" && (
              <Button
                type="button"
                variant="ghost"
                shape="pill"
                aria-label="查看原网页"
                onClick={onShowOriginal}
              >
                <ArrowUpRight data-icon="inline-start" />
                查看原网页
              </Button>
            )}
          </div>
        </div>
      </Empty>
    </section>
  )
}
