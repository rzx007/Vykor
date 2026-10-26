import { memo } from "react"
import { Orbit } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@renderer/components/ui/avatar"
import { agentAvatarSource } from "./agent-avatar-source"

export const AgentAvatar = memo(function AgentAvatar({
  agentId,
  size = 24,
}: {
  agentId: string
  size?: 20 | 24 | 32
}): React.JSX.Element {
  return (
    <Avatar
      aria-hidden="true"
      className="pointer-events-none bg-muted/30 after:border-0"
      style={{ width: size, height: size }}
    >
      <AvatarImage src={agentAvatarSource(agentId)} alt="" draggable={false} />
      <AvatarFallback>
        <Orbit className="size-3.5" strokeWidth={1.75} />
      </AvatarFallback>
    </Avatar>
  )
})
