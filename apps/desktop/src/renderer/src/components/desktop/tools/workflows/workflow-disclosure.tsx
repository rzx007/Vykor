import { useId, useState, type ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { AgentDisclosure } from "@renderer/components/agents/agent-disclosure"
import { Button } from "@renderer/components/ui/button"
import { cn } from "@renderer/lib/utils"

export function WorkflowDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div>
      <Button
        variant="ghost"
        shape="pill"
        size="sm"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
        {label}
      </Button>
      <AgentDisclosure id={id} open={open}>
        {open ? <div className="pt-2 text-sm">{children}</div> : null}
      </AgentDisclosure>
    </div>
  )
}
