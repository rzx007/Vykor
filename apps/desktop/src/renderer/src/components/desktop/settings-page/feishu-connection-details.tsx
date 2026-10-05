import { useId, useState } from "react"
import type { FeishuChannelSnapshot } from "@vykor/client"
import { Info, MessageCircle, Plus, ShieldCheck, UserRound, Users } from "lucide-react"
import { BouncyAccordion } from "@renderer/components/motion/bouncy-accordion"
import { Button } from "@renderer/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@renderer/components/ui/field"
import { Input } from "@renderer/components/ui/input"
import { Switch } from "@renderer/components/ui/switch"
import type { DesktopFeishuAllowInput, DesktopFeishuPatchInput } from "@shared/channel-types"

export function FeishuConnectionDetails({
  feishu,
  busy,
  onAllowAdd,
  onAllowRemove,
  onPatch,
}: {
  feishu: FeishuChannelSnapshot
  busy: boolean
  onAllowAdd: (input: DesktopFeishuAllowInput) => Promise<boolean>
  onAllowRemove: (name: string) => void
  onPatch: (input: DesktopFeishuPatchInput) => void
}): React.JSX.Element {
  const id = useId()
  const [adding, setAdding] = useState(false)
  const [allowId, setAllowId] = useState("")
  const [allowName, setAllowName] = useState("")
  const add = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!allowId.trim() || busy) return
    if (
      await onAllowAdd({
        id: allowId.trim(),
        ...(allowName.trim() ? { name: allowName.trim() } : {}),
      })
    ) {
      setAllowId("")
      setAllowName("")
      setAdding(false)
    }
  }
  return (
    <BouncyAccordion
      defaultValue="access"
      classNames={{
        item: "rounded-none! bg-transparent!",
        trigger: "px-0 min-h-14 focus-visible:ring-2 focus-visible:ring-ring",
        title: "text-sm",
        description: "text-xs",
        content: "[&>div]:px-0 [&>div]:sm:pl-11",
      }}
      items={[
        {
          id: "access",
          title: "访问权限 · " + feishu.allowFrom.length + " 个用户或群聊",
          icon: <ShieldCheck className="size-4" />,
          description: (
            <div className="flex flex-col gap-4">
              <p className="leading-relaxed">
                {feishu.allowFrom.length === 0
                  ? "尚未允许任何用户或群聊，机器人暂时不会回复消息。"
                  : "只回应允许的用户或群聊，用户或群聊任一匹配即可使用。"}
              </p>
              {feishu.allowFrom.length > 0 ? (
                <ul className="flex flex-col gap-3">
                  {feishu.allowFrom.map((entry) => (
                    <li key={entry.name} className="flex items-center gap-3">
                      <span
                        className="grid size-8 shrink-0 place-items-center rounded-full bg-muted"
                        aria-hidden="true"
                      >
                        {entry.id.startsWith("oc_") ? (
                          <Users className="size-4" />
                        ) : (
                          <UserRound className="size-4" />
                        )}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="text-foreground">{entry.name}</span>
                        <code className="break-all text-muted-foreground">{entry.id}</code>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="pill"
                        aria-label={"移除访问权限 " + entry.name}
                        disabled={busy}
                        onClick={() => onAllowRemove(entry.name)}
                      >
                        移除
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {adding ? (
                <form onSubmit={(event) => void add(event)} className="flex flex-col gap-4">
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor={id + "-allow-id"}>用户或群聊 ID</FieldLabel>
                      <Input
                        id={id + "-allow-id"}
                        aria-label="白名单 ID"
                        placeholder="ou_… 或 oc_…"
                        disabled={busy}
                        value={allowId}
                        onChange={(event) => setAllowId(event.target.value)}
                      />
                      <FieldDescription>
                        用户 ID 以 ou_ 开头，群聊 ID 以 oc_ 开头。
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={id + "-allow-name"}>备注（可选）</FieldLabel>
                      <Input
                        id={id + "-allow-name"}
                        aria-label="白名单备注"
                        placeholder="例如：项目群"
                        disabled={busy}
                        value={allowName}
                        onChange={(event) => setAllowName(event.target.value)}
                      />
                    </Field>
                  </FieldGroup>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      shape="pill"
                      disabled={busy}
                      onClick={() => setAdding(false)}
                    >
                      取消
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      shape="pill"
                      disabled={busy || !/^(ou|oc)_[A-Za-z0-9_-]+$/.test(allowId.trim())}
                    >
                      添加
                    </Button>
                  </div>
                </form>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  shape="pill"
                  className="w-fit"
                  disabled={busy}
                  onClick={() => setAdding(true)}
                >
                  <Plus data-icon="inline-start" />
                  添加用户或群聊
                </Button>
              )}
            </div>
          ),
        },
        {
          id: "messages",
          title: "消息偏好",
          icon: <MessageCircle className="size-4" />,
          description: (
            <FieldGroup>
              <Field orientation="horizontal">
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor={id + "-progress"}>发送工作进度</FieldLabel>
                  <FieldDescription>处理较长任务时，让你知道 Vykor 还在工作。</FieldDescription>
                </div>
                <Switch
                  id={id + "-progress"}
                  aria-label="发送进度"
                  checked={feishu.sendProgress ?? true}
                  disabled={busy}
                  onCheckedChange={(value) => onPatch({ sendProgress: value })}
                />
              </Field>
              <Field orientation="horizontal">
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor={id + "-tools"}>发送工具提示</FieldLabel>
                  <FieldDescription>在聊天中显示工具调用的简要说明。</FieldDescription>
                </div>
                <Switch
                  id={id + "-tools"}
                  aria-label="发送工具提示"
                  checked={feishu.sendToolHints ?? true}
                  disabled={busy}
                  onCheckedChange={(value) => onPatch({ sendToolHints: value })}
                />
              </Field>
            </FieldGroup>
          ),
        },
        {
          id: "info",
          title: "连接信息",
          icon: <Info className="size-4" />,
          description: (
            <dl className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-3">
                <dt className="w-16 shrink-0">App ID</dt>
                <dd className="min-w-0 text-foreground">
                  <code className="break-all">{feishu.appId}</code>
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-16 shrink-0">服务地区</dt>
                <dd className="text-foreground">
                  {feishu.domain === "lark" ? "Lark（国际版）" : "飞书（中国大陆）"}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-16 shrink-0">凭据</dt>
                <dd className="text-foreground">已保存在本机，不显示密钥。</dd>
              </div>
              {feishu.replyAtBotNames?.length ? (
                <div className="flex gap-3">
                  <dt className="w-16 shrink-0">群聊 @ 名称</dt>
                  <dd className="min-w-0 break-words text-foreground">
                    {feishu.replyAtBotNames.join("、")}
                  </dd>
                </div>
              ) : null}
            </dl>
          ),
        },
      ]}
    />
  )
}
