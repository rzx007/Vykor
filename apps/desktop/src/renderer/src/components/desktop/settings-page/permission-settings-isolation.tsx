import { useState } from "react"
import { Button } from "@renderer/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@renderer/components/ui/field"
import { Switch } from "@renderer/components/ui/switch"
import { Input } from "@renderer/components/ui/input"
import type { DesktopIsolationSettings } from "@shared/permission-settings-types"
import { SettingsListInput } from "./permission-settings-rules"

export function PermissionIsolationEditor({
  sandbox,
  available,
  reason,
  busy,
  onSave,
}: {
  sandbox: DesktopIsolationSettings
  available: boolean
  reason: string | null
  busy: boolean
  onSave(value: DesktopIsolationSettings, expected: DesktopIsolationSettings): void
}) {
  const [draft, setDraft] = useState(sandbox)
  const [baseline] = useState(sandbox)
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const filesystem = [
    ["allowRead", "允许读取目录"],
    ["denyRead", "禁止读取目录"],
    ["allowWrite", "允许写入目录"],
    ["denyWrite", "禁止写入目录"],
    ["extraAllowedRoots", "额外允许目录"],
  ] as const
  return (
    <section aria-labelledby="permission-isolation-heading" className="flex flex-col gap-5">
      <h2 id="permission-isolation-heading" className="text-base font-semibold">
        文件和网络边界
      </h2>
      <p className="text-sm text-muted-foreground">
        SRT 为本机命令进程增加访问限制。WSL
        本身不是安全隔离；这里只检查配置和依赖可用性，不代表已有进程采用了新配置。
      </p>
      {!available ? (
        <p role="status" className="text-sm">
          当前不可启用隔离：{reason ?? "环境不支持"}
        </p>
      ) : null}
      <FieldGroup>
        <Field orientation="horizontal" data-disabled={busy || (!available && !draft.enabled)}>
          <FieldContent>
            <FieldLabel htmlFor="isolation-enabled">启用本机隔离</FieldLabel>
            <FieldDescription>新任务启动时采用。更改不会中断已有任务。</FieldDescription>
          </FieldContent>
          <Switch
            id="isolation-enabled"
            checked={draft.enabled}
            disabled={busy || (!available && !draft.enabled)}
            onCheckedChange={(enabled) =>
              setDraft((current) => ({
                ...current,
                enabled,
                failIfUnavailable: enabled ? true : current.failIfUnavailable,
              }))
            }
          />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="isolation-required">隔离不可用时停止执行</FieldLabel>
            <FieldDescription>关闭后可能在没有隔离的情况下运行命令。</FieldDescription>
          </FieldContent>
          <Switch
            id="isolation-required"
            checked={draft.failIfUnavailable}
            disabled={busy}
            onCheckedChange={(failIfUnavailable) =>
              setDraft((current) => ({ ...current, failIfUnavailable }))
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="isolation-command">SRT 可执行文件</FieldLabel>
          <Input
            id="isolation-command"
            disabled={busy}
            value={draft.srt.runtimeCommand}
            onChange={(event) =>
              setDraft((current) => ({ ...current, srt: { runtimeCommand: event.target.value } }))
            }
          />
        </Field>
        {filesystem.map(([key, label]) => (
          <SettingsListInput
            key={key}
            id={`isolation-${key}`}
            label={label}
            value={draft.filesystem[key]}
            disabled={busy}
            description="相对目录按任务工作目录解析。"
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                filesystem: { ...current.filesystem, [key]: value },
              }))
            }
          />
        ))}
        {(
          [
            ["allowedDomains", "允许访问域名"],
            ["deniedDomains", "禁止访问域名"],
          ] as const
        ).map(([key, label]) => (
          <SettingsListInput
            key={key}
            id={`isolation-${key}`}
            label={label}
            value={draft.network[key]}
            disabled={busy}
            description="按运行工具支持的域名规则限制。"
            onChange={(value) =>
              setDraft((current) => ({ ...current, network: { ...current.network, [key]: value } }))
            }
          />
        ))}
        <p className="text-sm text-muted-foreground">
          启用隔离后，SRT
          使用上方域名允许和禁止列表限制命令访问网络。关闭隔离时，这些列表不会限制命令进程。
        </p>
      </FieldGroup>
      <div className="flex gap-2">
        <Button disabled={busy || !dirty} onClick={() => onSave(draft, baseline)}>
          保存访问边界
        </Button>
        <Button variant="ghost" disabled={busy || !dirty} onClick={() => setDraft(baseline)}>
          取消修改
        </Button>
      </div>
    </section>
  )
}
