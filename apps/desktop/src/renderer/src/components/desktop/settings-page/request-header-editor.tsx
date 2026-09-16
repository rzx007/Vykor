import { Plus, Trash2 } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { FieldDescription, FieldLegend, FieldSet } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import { REQUEST_HEADER_DESCRIPTION, type RequestHeaderRow } from "./request-header-form"

interface RequestHeaderEditorProps {
  rows: RequestHeaderRow[]
  invalidMessage?: string | null
  onChange: (rows: RequestHeaderRow[]) => void
  onAddRow: () => void
  legend?: string
}

export function RequestHeaderEditor({
  rows,
  invalidMessage,
  onChange,
  onAddRow,
  legend = "请求头（可选）",
}: RequestHeaderEditorProps): React.JSX.Element {
  return (
    <FieldSet data-invalid={invalidMessage ? true : undefined}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <FieldLegend>{legend}</FieldLegend>
          <FieldDescription>{invalidMessage ?? REQUEST_HEADER_DESCRIPTION}</FieldDescription>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onAddRow}>
          <Plus data-icon="inline-start" />
          添加请求头
        </Button>
      </div>
      {rows.length > 0 ? (
        <div className="flex flex-col gap-3">
          {rows.map((header, index) => (
            <div key={header.key} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Input
                value={header.name}
                aria-label={`请求头 ${index + 1} 名称`}
                aria-invalid={invalidMessage ? true : undefined}
                onChange={(event) =>
                  onChange(
                    rows.map((item) =>
                      item.key === header.key ? { ...item, name: event.target.value } : item
                    )
                  )
                }
                placeholder="Header-Name"
              />
              <Input
                value={header.value}
                aria-label={`请求头 ${index + 1} 值`}
                aria-invalid={invalidMessage ? true : undefined}
                onChange={(event) =>
                  onChange(
                    rows.map((item) =>
                      item.key === header.key ? { ...item, value: event.target.value } : item
                    )
                  )
                }
                placeholder="value 或 {{sessionId}}"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`删除请求头 ${index + 1}`}
                onClick={() => onChange(rows.filter((item) => item.key !== header.key))}
              >
                <Trash2 data-icon="inline-start" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </FieldSet>
  )
}
