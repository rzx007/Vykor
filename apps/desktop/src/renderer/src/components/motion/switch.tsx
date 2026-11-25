// Based on https://beui.dev/components/motion/switch
import { motion, MotionConfig, useReducedMotion } from "motion/react"
import { cn } from "@renderer/lib/utils"

const thumbSpring = { type: "spring", stiffness: 800, damping: 80, mass: 4 } as const

interface SwitchProps {
  id: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}

export function MotionSwitch({ id, checked, onCheckedChange, disabled }: SwitchProps): React.JSX.Element {
  const reduceMotion = useReducedMotion()

  return (
    <MotionConfig transition={reduceMotion ? { duration: 0 } : thumbSpring}>
      <motion.button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        initial={false}
        className={cn(
          "group inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border border-transparent px-1 outline-none",
          "motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-60",
          checked ? "justify-end bg-primary" : "justify-start border-border bg-muted"
        )}
      >
        <motion.span
          layout={!reduceMotion}
          className={cn(
            "pointer-events-none block size-5 rounded-full",
            "motion-safe:transition-transform motion-safe:group-enabled:group-active:scale-95",
            checked ? "bg-primary-foreground" : "bg-muted-foreground"
          )}
        />
      </motion.button>
    </MotionConfig>
  )
}
