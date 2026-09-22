import { Message, MessageContent } from "@renderer/components/ui/message"
import { Skeleton } from "@renderer/components/ui/skeleton"
import { cn } from "@renderer/lib/utils"

export function ConversationTranscriptSkeletonOverlay({
  loading,
}: {
  loading: boolean
}): React.JSX.Element {
  return (
    <div
      aria-hidden={!loading}
      className={cn(
        "pointer-events-none absolute inset-0 z-10 overflow-hidden bg-conversation transition-opacity duration-150 ease-out motion-reduce:transition-none",
        loading ? "opacity-100" : "opacity-0 **:data-[slot=skeleton]:animate-none"
      )}
    >
      <div className="mx-auto w-full max-w-190 px-6 pt-7 pb-5 text-content-foreground">
        <ConversationTranscriptSkeleton />
      </div>
    </div>
  )
}

export function ConversationTranscriptSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6" aria-busy aria-label="正在加载会话">
      <UserTurn widths={["w-52"]} />
      <AssistantTurn widths={["w-full", "w-5/6", "w-2/3"]} />
      <UserTurn widths={["w-36"]} />
      <AssistantTurn widths={["w-4/5", "w-1/2"]} />
    </div>
  )
}

function UserTurn({ widths }: { widths: string[] }): React.JSX.Element {
  return (
    <div>
      <Message align="end">
        <MessageContent className="flex w-full max-w-[78%] flex-col items-end">
          <div className="w-full max-w-64 overflow-hidden rounded-xl bg-input/80 px-4 py-3">
            {widths.map((width) => (
              <Skeleton key={width} className={`h-3.5 motion-reduce:animate-none ${width}`} />
            ))}
          </div>
        </MessageContent>
      </Message>
    </div>
  )
}

function AssistantTurn({ widths }: { widths: string[] }): React.JSX.Element {
  return (
    <div>
      <div className="flex min-w-0 flex-col gap-2">
        {widths.map((width) => (
          <Skeleton key={width} className={`h-3.5 motion-reduce:animate-none ${width}`} />
        ))}
      </div>
    </div>
  )
}
