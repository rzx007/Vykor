import { Checkbox } from "@renderer/components/ui/checkbox"
import { Input } from "@renderer/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select"
import type { SessionGoal } from "@shared/session-types"

type GoalEditChange = {
  changeKind: "refine" | "pivot"
  changeReason: string
  replaceRequirementIds: string[]
}

export function GoalEditFields({
  goal,
  changeKind,
  changeReason,
  replaceRequirementIds,
  disabled,
  onChange,
}: GoalEditChange & {
  goal: SessionGoal
  disabled: boolean
  onChange: (change: Partial<GoalEditChange>) => void
}): React.JSX.Element {
  return (
    <div className="space-y-3 border-b border-border/60 px-4 pb-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground">修改方式</span>
        <Select
          value={changeKind}
          items={[
            { value: "refine", label: "补充条件" },
            { value: "pivot", label: "改变方向" },
          ]}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "refine" || value === "pivot") onChange({ changeKind: value })
          }}
        >
          <SelectTrigger aria-label="目标变更类型" className="h-8 w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="refine">补充条件</SelectItem>
            <SelectItem value="pivot">改变方向</SelectItem>
          </SelectContent>
        </Select>
        {/* <span className="text-xs text-muted-foreground">
          {changeKind === "pivot" ? "重新定义目标与完成条件" : "保留已有条件，补充本次要求"}
        </span> */}
      </div>
      <label className="grid gap-1.5">
        <span>
          变更原因 <span className="text-xs text-muted-foreground">必填</span>
        </span>
        <Input
          aria-label="目标变更原因"
          aria-required="true"
          placeholder="例如：补充验收标准"
          value={changeReason}
          disabled={disabled}
          onChange={(event) => onChange({ changeReason: event.target.value })}
        />
      </label>
      {changeKind === "refine" && goal.requirements.length > 0 ? (
        <details className="text-xs">
          <summary className="w-fit cursor-pointer rounded-sm py-1 text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
            替换已有条件
            {replaceRequirementIds.length
              ? `（已选 ${replaceRequirementIds.length} 项）`
              : "（可选）"}
          </summary>
          <div className="mt-2 max-h-36 space-y-2 overflow-y-auto pr-1">
            {goal.requirements.map((item) => (
              <label key={item.id} className="flex items-start gap-2 leading-5">
                <Checkbox
                  className="mt-0.5"
                  checked={replaceRequirementIds.includes(item.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange({
                      replaceRequirementIds: checked
                        ? [...replaceRequirementIds, item.id]
                        : replaceRequirementIds.filter((id) => id !== item.id),
                    })
                  }
                />
                <span className="min-w-0 break-words">{item.text}</span>
              </label>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}
