import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@renderer/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@renderer/components/ui/collapsible"
import { Dialog } from "@renderer/components/ui/dialog"
import { FieldGroup } from "@renderer/components/ui/field"
import type { DesktopProviderInfo } from "@shared/provider-types"
import { ProviderApiKeyField, ProviderDialogForm } from "./provider-dialog-form"
import { RequestHeaderEditor } from "./request-header-editor"
import {
  headersFromRows,
  rowsFromHeaders,
  type RequestHeaderError,
  type RequestHeaderRow,
} from "./request-header-form"

export interface ProviderConnectionSubmitValue {
  apiKey: string
  headers?: Record<string, string>
  secretHeaders?: Record<string, string | null>
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
  const fields = useRef<HTMLDivElement>(null)
  const isCatalog = provider?.source === "catalog"
  const [apiKey, setApiKey] = useState("")
  const [replacingApiKey, setReplacingApiKey] = useState(false)
  const [headerRows, setHeaderRows] = useState<RequestHeaderRow[]>([])
  const [headersDirty, setHeadersDirty] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [headerError, setHeaderError] = useState<RequestHeaderError | null>(null)
  const hasSavedKey = provider?.credentialSource === "credentials"
  const hasNewKey = Boolean(apiKey.trim())
  const canSaveHeaders = Boolean(isCatalog && provider?.connected && headersDirty)

  /* eslint-disable react-hooks/set-state-in-effect -- Opening the dialog resets its editable draft. */
  useEffect(() => {
    if (!open || !provider) return
    setApiKey("")
    setReplacingApiKey(false)
    setAdvancedOpen(false)
    setHeaderError(null)
    setHeaderRows(
      provider.source === "catalog"
        ? rowsFromHeaders(provider.headers, provider.secretHeaderNames)
        : []
    )
    setHeadersDirty(false)
  }, [open, provider])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (headerError) fields.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }, [headerError])

  const updateHeaderRows = (rows: RequestHeaderRow[]): void => {
    setHeaderRows(rows)
    setHeadersDirty(true)
    setHeaderError(null)
  }

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!provider || (!hasNewKey && !canSaveHeaders) || busy) return

    const value: ProviderConnectionSubmitValue = { apiKey: apiKey.trim() }

    if (isCatalog && headersDirty) {
      const result = headersFromRows(headerRows, provider.secretHeaderNames)
      if (!result.ok) {
        setAdvancedOpen(true)
        setHeaderError(result)
        return
      }
      value.headers = result.headers
      if (result.secretHeaders) value.secretHeaders = result.secretHeaders
    }

    setHeaderError(null)
    onSubmit(value)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)}>
      <ProviderDialogForm
        wide={isCatalog}
        title={`${provider?.connected ? "更新连接" : "连接"} ${provider?.displayName ?? ""}`}
        busy={busy}
        submitLabel={isCatalog && provider?.connected && !hasNewKey ? "保存请求头" : "连接"}
        canSubmit={hasNewKey || canSaveHeaders}
        hasNewKey={hasNewKey}
        onSubmit={submit}
      >
        <FieldGroup ref={fields} className="gap-4">
          <ProviderApiKeyField
            id="provider-api-key"
            value={apiKey}
            saved={hasSavedKey && !replacingApiKey}
            placeholder={hasSavedKey ? "输入新的 API 密钥" : "输入 API 密钥"}
            onReplace={() => setReplacingApiKey(true)}
            onChange={setApiKey}
          />
          {isCatalog && (
            <Collapsible
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              className="border-t border-border/70 pt-2"
            >
              <CollapsibleTrigger
                render={<Button type="button" variant="ghost" shape="pill" size="sm" />}
              >
                高级选项
                <ChevronDown
                  data-icon="inline-end"
                  className="opacity-60 in-aria-expanded:rotate-180"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                {advancedOpen && (
                  <RequestHeaderEditor
                    rows={headerRows}
                    error={headerError}
                    onChange={updateHeaderRows}
                    onAddRow={() =>
                      updateHeaderRows([
                        ...headerRows,
                        { key: `new-header-${nextRowId.current++}`, name: "", value: "" },
                      ])
                    }
                  />
                )}
              </CollapsibleContent>
            </Collapsible>
          )}
        </FieldGroup>
      </ProviderDialogForm>
    </Dialog>
  )
}
