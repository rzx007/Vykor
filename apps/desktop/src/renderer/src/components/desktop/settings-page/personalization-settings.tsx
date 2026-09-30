import { ArrowLeft, ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Card, CardContent } from "@renderer/components/ui/card"
import { Separator } from "@renderer/components/ui/separator"
import { Switch } from "@renderer/components/ui/switch"
import { Textarea } from "@renderer/components/ui/textarea"
import type {
  DesktopSettingsSnapshot,
  UpdateDesktopMemorySettingsInput,
} from "@shared/settings-types"

import { errorMessage } from "./settings-error-message"

export function PersonalizationSettings(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.desktop.settings
      .snapshot()
      .then((result) => {
        if (!cancelled) setSnapshot(result)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const updateMemory = (patch: UpdateDesktopMemorySettingsInput): void => {
    if (saving) return
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateMemorySettings(patch)
      .then(setSnapshot)
      .catch((saveError: unknown) => setError(errorMessage(saveError)))
      .finally(() => setSaving(false))
  }

  const closeEditor = (): void => {
    setDraft(snapshot?.customInstructions ?? "")
    setError(null)
    setEditing(false)
  }

  const saveInstructions = (): void => {
    if (!snapshot || saving || draft === snapshot.customInstructions) return
    setSaving(true)
    setError(null)
    void window.desktop.settings
      .updateCustomInstructions({ content: draft })
      .then((result) => {
        setSnapshot(result)
        setEditing(false)
      })
      .catch((saveError: unknown) => setError(errorMessage(saveError)))
      .finally(() => setSaving(false))
  }

  if (editing) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-8 sm:px-10">
        <div className="flex items-center justify-between gap-4">
          <Button variant="ghost" size="sm" onClick={closeEditor} disabled={saving}>
            <ArrowLeft data-icon="inline-start" />
            返回
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={closeEditor} disabled={saving}>
              取消
            </Button>
            <Button
              size="sm"
              onClick={saveInstructions}
              disabled={saving || draft === snapshot?.customInstructions}
            >
              保存
            </Button>
          </div>
        </div>
        <div className="mx-auto mt-12 max-w-3xl">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Vykor 自定义指令</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            为使用全局默认设置的聊天提供额外指令和背景信息。项目或会话设置可覆盖它。
          </p>
          <Textarea
            aria-label="自定义指令内容"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="mt-8 min-h-72 resize-y p-4 leading-6"
            placeholder="例如：回答时先给结论，再说明原因。"
          />
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-6 py-12 sm:px-10">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-xl font-semibold tracking-tight">个性化</h1>
        <p className="text-sm text-muted-foreground">管理 Vykor 的额外指令和项目长期记忆。</p>
      </header>

      <section aria-labelledby="personalization-memory" className="flex flex-col gap-4">
        <div>
          <h2 id="personalization-memory" className="text-base font-semibold">
            项目长期记忆
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">相关记忆保存在本机，按项目检索。</p>
        </div>
        <Card className="py-0">
          <CardContent className="px-5">
            <div className="flex min-h-18 items-center justify-between gap-5 py-4">
              <div className="min-w-0">
                <h3 className="text-sm font-medium">启用项目长期记忆</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  在聊天中使用相关项目记忆。关闭后不再提取新记忆，已有记忆不会删除。
                </p>
              </div>
              <Switch
                aria-label="项目长期记忆"
                checked={snapshot?.memoryEnabled ?? false}
                disabled={loading || saving || !snapshot}
                onCheckedChange={(enabled) => updateMemory({ enabled })}
              />
            </div>
            <Separator />
            <div className="flex min-h-18 items-center justify-between gap-5 py-4">
              <div className="min-w-0">
                <h3 className="text-sm font-medium">自动提取记忆</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  在任务成功结束后，从用户明确提供的稳定信息中提取项目记忆。
                </p>
              </div>
              <Switch
                aria-label="自动提取记忆"
                checked={snapshot?.autoExtractEnabled ?? false}
                disabled={loading || saving || !snapshot?.memoryEnabled}
                onCheckedChange={(autoExtractEnabled) => updateMemory({ autoExtractEnabled })}
              />
            </div>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">
          这两个开关不控制 SOUL.md、USER.md、环境事实或会话检查点。
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="personalization-instructions" className="flex flex-col gap-4">
        <h2 id="personalization-instructions" className="text-base font-semibold">
          自定义指令
        </h2>
        <Card className="py-0">
          <CardContent className="px-0">
            <button
              type="button"
              aria-label="编辑自定义指令"
              disabled={loading || !snapshot}
              onClick={() => {
                setDraft(snapshot?.customInstructions ?? "")
                setError(null)
                setEditing(true)
              }}
              className="flex w-full items-center justify-between gap-4 rounded-xl px-5 py-5 text-left hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">Vykor</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  为使用全局默认设置的聊天提供额外指令。项目设置可进一步补充。
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
