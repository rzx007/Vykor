import { CircleAlert } from "lucide-react"
import { useEffect, useState } from "react"

import { Alert, AlertDescription } from "@renderer/components/ui/alert"

export function ScopedOperationError({
  error,
  onDismiss,
}: {
  error: string | null
  onDismiss?: () => void
}): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState<string | null>(null)
  useEffect(() => setDismissed(null), [error])
  if (!error || dismissed === error) return null

  return (
    <Alert variant="destructive" aria-live="assertive">
      <CircleAlert />
      <AlertDescription>
        {error}
        <button type="button" className="ml-2 underline" onClick={() => { setDismissed(error); onDismiss?.() }}>
          关闭
        </button>
      </AlertDescription>
    </Alert>
  )
}
