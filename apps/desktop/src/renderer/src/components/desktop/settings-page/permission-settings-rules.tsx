import { SettingsGroup } from "./settings-group"
import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import { Textarea } from "@renderer/components/ui/textarea"
import type { DesktopPermissionRules } from "@shared/permission-settings-types"

const modes = [
  { value: "default", label: "手动批准" },
  { value: "plan", label: "只读计划" },
  { value: "full_auto", label: "自动批准" },
] as const

export function readSettingLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ]
}

export function SettingsListInput({
  id,
  label,
  description,
  placeholder = "每行一项，留空不设置",
  value,
  disabled,
  onChange,
}: {
  id: string
  label: string
  description: string
  placeholder?: string
  value: string[]
  disabled: boolean
  onChange(value: string[]): void
}) {
  const [text, setText] = useState(value.join("\n"))
  useEffect(() => {
    if (JSON.stringify(readSettingLines(text)) !== JSON.stringify(value)) setText(value.join("\n"))
  }, [value, text])
  return (
    <Field data-disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        disabled={disabled}
        value={text}
        rows={3}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value)
          onChange(readSettingLines(event.target.value))
        }}
      />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  )
}

export function PermissionRulesEditor({
  permission,
  busy,
  onSave,
  defaultCwd = "",
}: {
  permission: DesktopPermissionRules
  busy: boolean
  defaultCwd?: string
  onSave(value: DesktopPermissionRules, expected: DesktopPermissionRules): void
}) {
  const [draft, setDraft] = useState(permission)
  const [baseline] = useState(permission)
  const [toolName, setToolName] = useState("Read")
  const [path, setPath] = useState("")
  const [command, setCommand] = useState("")
  const [cwd, setCwd] = useState(defaultCwd)
  const [decision, setDecision] = useState("")
  const [checking, setChecking] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const update = (patch: Partial<DesktopPermissionRules>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setDecision("")
  }
  const lists = [
    ["deniedTools", "禁止使用的工具", "禁止规则优先于自动批准。"],
    ["autoApproveTools", "自动通过的工具", "手动批准模式下也可通过，仍遵守禁止规则。"],
    ["allowedTools", "工具允许列表", "手动模式的自动通过列表可放行名单外工具，禁止规则优先。"],
    ["deniedCommands", "禁止的命令", "支持 * 匹配任意内容、? 匹配一个字符。"],
  ] as const

  async function check() {
    setChecking(true)
    setDecision("")
    try {
      const result = await window.desktop.permissionSettings.check({
        permission: draft,
        toolName,
        path,
        command,
        cwd,
      })
      setDecision(
        `${{ allow: "允许", deny: "禁止", ask: "需要批准" }[result.action]}：${result.reason ?? "按当前规则判断"}`
      )
    } catch (error) {
      setDecision(error instanceof Error ? error.message : String(error))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <FieldGroup className="settings-panel">
        <Field data-disabled={busy}>
          <FieldLabel htmlFor="permission-mode">新会话默认批准方式</FieldLabel>
          <Select
            items={modes}
            value={draft.mode}
            onValueChange={(value) => {
              if (value) update({ mode: value })
            }}
          >
            <SelectTrigger id="permission-mode" disabled={busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {modes.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            新会话生效，已有会话不变；只读计划禁止写入和有副作用的命令。
          </FieldDescription>
        </Field>
        {lists.map(([key, label, description]) => (
          <SettingsListInput
            key={key}
            id={`permissions-${key}`}
            label={label}
            description={description}
            value={draft[key] ?? []}
            disabled={busy}
            onChange={(value) => update({ [key]: value })}
          />
        ))}
        <Field>
          <FieldLabel>文件路径规则</FieldLabel>
          <FieldDescription>
            从上到下取首条匹配，任一目标被禁止则拦截。支持 * 和 ?；不等于系统隔离。
          </FieldDescription>
          {(draft.pathRules ?? []).map((rule, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`路径规则 ${index + 1}`}
                value={rule.pattern}
                disabled={busy}
                className="min-w-44 flex-1"
                onChange={(event) =>
                  update({
                    pathRules: draft.pathRules!.map((entry, position) =>
                      position === index ? { ...entry, pattern: event.target.value } : entry
                    ),
                  })
                }
              />
              <Select
                items={[
                  { value: "deny", label: "禁止" },
                  { value: "allow", label: "允许" },
                ]}
                value={rule.allow ? "allow" : "deny"}
                onValueChange={(value) =>
                  update({
                    pathRules: draft.pathRules!.map((entry, position) =>
                      position === index ? { ...entry, allow: value === "allow" } : entry
                    ),
                  })
                }
              >
                <SelectTrigger disabled={busy} aria-label={`规则 ${index + 1} 的动作`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="deny">禁止</SelectItem>
                    <SelectItem value="allow">允许</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                disabled={busy || index === 0}
                onClick={() => {
                  const rules = [...draft.pathRules!]
                  ;[rules[index - 1], rules[index]] = [rules[index]!, rules[index - 1]!]
                  update({ pathRules: rules })
                }}
              >
                上移
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  update({
                    pathRules: draft.pathRules!.filter((_, position) => position !== index),
                  })
                }
              >
                删除
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              update({ pathRules: [...(draft.pathRules ?? []), { pattern: "", allow: false }] })
            }
          >
            添加路径规则
          </Button>
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !dirty} onClick={() => onSave(draft, baseline)}>
          {busy ? "处理中…" : "保存权限设置"}
        </Button>
        <Button
          variant="ghost"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(baseline)
            setDecision("")
          }}
        >
          取消修改
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            update({
              mode: "default",
              allowedTools: [],
              deniedTools: [],
              autoApproveTools: [],
              deniedCommands: [],
              pathRules: [],
            })
          }
        >
          恢复默认规则
        </Button>
      </div>
      <SettingsGroup title="检查规则" id="permission-check-heading">
        <p className="text-sm text-muted-foreground">
          仅检查草稿，不执行命令或读取文件；不含项目、插件及系统隔离规则。
        </p>
        <FieldGroup>
          {[
            ["工具名称", toolName, setToolName],
            ["项目目录", cwd, setCwd],
            ["目标文件路径", path, setPath],
            ["命令", command, setCommand],
          ].map(([label, value, setter], index) => (
            <Field key={index}>
              <FieldLabel htmlFor={`permission-check-${index}`}>{label as string}</FieldLabel>
              <Input
                id={`permission-check-${index}`}
                value={value as string}
                disabled={busy || checking}
                onChange={(event) => {
                  ;(setter as (value: string) => void)(event.target.value)
                  setDecision("")
                }}
              />
            </Field>
          ))}
        </FieldGroup>
        <Button
          variant="outline"
          disabled={busy || checking || !cwd.trim() || !toolName.trim()}
          onClick={() => void check()}
        >
          {checking ? "检查中…" : "检查规则"}
        </Button>
        {decision ? (
          <p role="status" className="text-sm break-words">
            {decision}
          </p>
        ) : null}
      </SettingsGroup>
    </div>
  )
}
