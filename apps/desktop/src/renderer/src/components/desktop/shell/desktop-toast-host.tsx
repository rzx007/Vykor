import { useEffect } from "react"

import {
  AnimatedToastStack,
  useAnimatedToastStack,
} from "@renderer/components/motion/animated-toast-stack"
import { setToastDispatcher } from "@renderer/lib/toast"

export function DesktopToastHost(): React.JSX.Element {
  const { toasts, showToast, updateToast, dismissToast } = useAnimatedToastStack({ limit: 5 })

  useEffect(() => {
    setToastDispatcher({ showToast, updateToast, dismissToast })
    return () => setToastDispatcher(null)
  }, [showToast, updateToast, dismissToast])

  return (
    <AnimatedToastStack
      toasts={toasts}
      onDismiss={dismissToast}
      position="top-center"
      fixed
      maxVisible={4}
    />
  )
}
