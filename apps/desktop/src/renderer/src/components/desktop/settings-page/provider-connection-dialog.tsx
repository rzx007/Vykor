import { ChevronDown, LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import type { DesktopProviderInfo } from "@shared/provider-types"
import { RequestHeaderEditor } from "./request-header-editor"
import { headersFromRows, rowsFromHeaders, type RequestHeaderRow } from "./request-header-form"

export interface ProviderConnectionSubmitValue {
  apiKey: string
  headers?: Record<string, string>
}

interface ProviderConnectionDialogProps {
  open: boolean
  provider: DesktopProviderInfo | null
  busy: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (value: ProviderConnectionSubmitValue) => void
}

export function ProviderConnectionDialog({
  open,
  provider,
  busy,
  onOpenChange,
  onSubmit,
}: ProviderConnectionDialogProps): React.JSX.Element {
  const nextRowId = useRef(1)
  const isCatalog = provider?.source === "catalog"
  const [apiKey, setApiKey] = useState("")
  const [headerRows, setHeaderRows] = useState<RequestHeaderRow[]>([])
  const [headersDirty, setHeadersDirty] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [headerError, setHeaderError] = useState<string | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect -- Opening the dialog resets its editable draft. */
  useEffect(() => {
    if (!open || !provider) return
    setApiKey("")
    setAdvancedOpen(false)
    setHeaderError(null)
    if (provider.source === "catalog") {
      setHeaderRows(rowsFromHeaders(provider.headers))
      setHeadersDirty(false)
      nextRowId.current = Object.keys(provider.headers ?? {}).length + 1
    } else {
      setHeaderRows([])
      setHeadersDirty(false)
    }
  }, [open, provider])
  /* eslint-enable react-hooks/set-state-in-effect */

  const updateHeaderRows = (rows: RequestHeaderRow[]): void => {
    setHeaderRows(rows)
    setHeadersDirty(true)
    setHeaderError(null)
  }

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!provider || !apiKey.trim() || busy) return

    const value: ProviderConnectionSubmitValue = {
      apiKey: apiKey.trim(),
    }

    if (isCatalog) {
      if (headersDirty) {
        const result = headersFromRows(headerRows)
        if (!result.ok) {
          setHeaderError(result.message)
          return
        }
        value.headers = result.headers
      }
    }

    setHeaderError(null)
    onSubmit(value)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>连接 {provider?.displayName}</DialogTitle>
            <DialogDescription>
              API 密钥会由 OpenHarness 认证服务保存到本地凭证文件，不会写入普通设置。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-api-key">API 密钥</FieldLabel>
              <Input
                id="provider-api-key"
                type="password"
                autoFocus
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="输入 API 密钥"
              />
              <FieldDescription>保存后页面只显示凭证来源，不会再次读取密钥。</FieldDescription>
            </Field>
            {isCatalog ? (
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-between px-0"
                    />
                  }
                >
                  高级选项
                  <ChevronDown data-icon="inline-end" className="opacity-60" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {advancedOpen ? (
                    <div className="pt-3">
                      <RequestHeaderEditor
                        rows={headerRows}
                        invalidMessage={headerError}
                        onChange={updateHeaderRows}
                        onAddRow={() =>
                          updateHeaderRows([
                            ...headerRows,
                            { key: `header-${nextRowId.current++}`, name: "", value: "" },
                          ])
                        }
                      />
                    </div>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" disabled={busy}>
                  取消
                </Button>
              }
            />
            <Button type="submit" disabled={!apiKey.trim() || busy}>
              {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
              {busy ? "连接中..." : "连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
