import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog"
import type { JsonValue, PluginUiInstanceRecord } from "@vykor/client"
export interface PluginUiConfirmationDetails {
  instance: PluginUiInstanceRecord
  label: string
  toolName?: string
  args: Record<string, JsonValue>
  dismiss?: boolean
}
export function PluginUiConfirmation({
  details,
  decide,
}: {
  details: PluginUiConfirmationDetails | null
  decide(accepted: boolean): void
}) {
  return (
    <AlertDialog
      open={Boolean(details)}
      onOpenChange={(open) => {
        if (!open) decide(false)
      }}
    >
      <AlertDialogContent className="max-h-[80vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{details?.dismiss ? "取消此次交互" : "确认插件操作"}</AlertDialogTitle>
          <AlertDialogDescription>
            {details?.instance.pluginId} · {details?.instance.pluginVersion}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-w-0 space-y-2 text-sm">
          <p>{details?.label}</p>
          {details?.toolName && (
            <p className="break-all text-muted-foreground">实际工具：{details.toolName}</p>
          )}
          {!details?.dismiss && (
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs break-all whitespace-pre-wrap">
              {JSON.stringify(details?.args, null, 2)}
            </pre>
          )}
          {details?.dismiss && (
            <p className="text-muted-foreground">
              原始结果仍然保留。关闭显示与取消交互是不同的操作。
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => decide(false)}>返回</AlertDialogCancel>
          <AlertDialogAction onClick={() => decide(true)}>
            {details?.dismiss ? "确认取消" : "确认执行"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
