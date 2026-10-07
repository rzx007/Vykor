import { ArrowLeft, ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import { Card, CardContent } from "@renderer/components/ui/card"
import { Textarea } from "@renderer/components/ui/textarea"
import type { DesktopSettingsSnapshot } from "@shared/settings-types"

import { errorMessage } from "./settings-error-message"
import { PersonalizationMemoryManagement } from "./personalization-memory-management"

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
            默认指令，可被项目或会话设置覆盖。
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
    <div className="settings-content-column">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-xl font-semibold tracking-tight">个性化</h1>
        <p className="text-sm text-muted-foreground">设置默认指令和项目记忆。</p>
      </header>

      <PersonalizationMemoryManagement />

      <section aria-labelledby="personalization-instructions" className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
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
                  默认指令，项目设置可补充。
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
