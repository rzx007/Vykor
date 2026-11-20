import { Plus, Trash2 } from "lucide-react"
import { useId } from "react"

import { Input } from "@renderer/components/motion/input"
import { Button } from "@renderer/components/ui/button"
import { Switch } from "@renderer/components/ui/switch"
import { FieldHelp } from "../shared/field-help"
import {
  REQUEST_HEADER_DESCRIPTION,
  type RequestHeaderError,
  type RequestHeaderRow,
} from "./request-header-form"

interface RequestHeaderEditorProps {
  rows: RequestHeaderRow[]
  error?: RequestHeaderError | null
  onChange: (rows: RequestHeaderRow[]) => void
  onAddRow: () => void
}

export function RequestHeaderEditor({
  rows,
  error,
  onChange,
  onAddRow,
}: RequestHeaderEditorProps): React.JSX.Element {
  const headingId = useId()
  const updateRow = (key: string, patch: Partial<RequestHeaderRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-1">
          <h3 id={headingId} className="text-sm font-medium">
            请求头（可选）
          </h3>
          <FieldHelp label="请求头说明">{REQUEST_HEADER_DESCRIPTION}</FieldHelp>
        </div>
        <Button type="button" variant="outline" shape="pill" onClick={onAddRow}>
          <Plus data-icon="inline-start" />
          添加请求头
        </Button>
      </div>
      {rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {rows.map((header, index) => (
            <div key={header.key} className="flex items-start gap-2">
              <div className="grid min-w-0 flex-1 gap-2 @sm/provider-form:grid-cols-2">
                <Input
                  value={header.name}
                  aria-label={`请求头 ${index + 1} 名称`}
                  error={
                    error?.rowKey === header.key && error.field === "name"
                      ? error.message
                      : undefined
                  }
                  onChange={(name) => updateRow(header.key, { name })}
                  placeholder="请求头名称"
                />
                <Input
                  value={header.value}
                  type={header.secret ? "password" : "text"}
                  autoComplete={header.secret ? "off" : undefined}
                  aria-label={`请求头 ${index + 1} 值`}
                  error={
                    error?.rowKey === header.key && error.field === "value"
                      ? error.message
                      : undefined
                  }
                  onChange={(value) => updateRow(header.key, { value })}
                  placeholder={
                    header.secret && header.savedSecretName === header.name
                      ? "留空保留已保存的值"
                      : "值"
                  }
                />
              </div>
              <label className="flex h-8 shrink-0 items-center gap-1 text-xs">
                <Switch
                  checked={header.secret ?? false}
                  aria-label={`请求头 ${index + 1} 机密值`}
                  onCheckedChange={(secret) => updateRow(header.key, { secret })}
                />
                机密
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                shape="circle"
                aria-label={`删除请求头 ${index + 1}`}
                title={`删除请求头 ${index + 1}`}
                onClick={() => onChange(rows.filter((item) => item.key !== header.key))}
              >
                <Trash2 data-icon="inline-start" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
