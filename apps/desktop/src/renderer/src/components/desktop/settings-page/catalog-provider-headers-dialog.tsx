import { LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import type { DesktopProviderInfo } from "@shared/provider-types"
import { RequestHeaderEditor } from "./request-header-editor"
import { headersFromRows, rowsFromHeaders, type RequestHeaderRow } from "./request-header-form"

interface CatalogProviderHeadersDialogProps {
  provider: DesktopProviderInfo
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (headers: Record<string, string>) => void
}

export function CatalogProviderHeadersDialog({
  provider,
  busy,
  onOpenChange,
  onSubmit,
}: CatalogProviderHeadersDialogProps): React.JSX.Element {
  const nextRowId = useRef(1)
  const [headerRows, setHeaderRows] = useState<RequestHeaderRow[]>(() =>
    rowsFromHeaders(provider.headers)
  )
  const [headerError, setHeaderError] = useState<string | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect -- Opening the dialog resets its editable draft. */
  useEffect(() => {
    setHeaderRows(rowsFromHeaders(provider.headers))
    setHeaderError(null)
    nextRowId.current = Object.keys(provider.headers ?? {}).length + 1
  }, [provider])
  /* eslint-enable react-hooks/set-state-in-effect */

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (busy) return
    const result = headersFromRows(headerRows)
    if (!result.ok) {
      setHeaderError(result.message)
      return
    }
    setHeaderError(null)
    onSubmit(result.headers)
  }

  return (
    <Dialog open onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>编辑 {provider.displayName} 请求头</DialogTitle>
            <DialogDescription>
              仅更新目录供应商的请求头模板，不会读取或修改已保存的凭证。
            </DialogDescription>
          </DialogHeader>
          <RequestHeaderEditor
            rows={headerRows}
            invalidMessage={headerError}
            onChange={(rows) => {
              setHeaderRows(rows)
              setHeaderError(null)
            }}
            onAddRow={() =>
              setHeaderRows((current) => [
                ...current,
                { key: `header-${nextRowId.current++}`, name: "", value: "" },
              ])
            }
          />
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" disabled={busy}>
                  取消
                </Button>
              }
            />
            <Button type="submit" disabled={busy}>
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
              {busy ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
