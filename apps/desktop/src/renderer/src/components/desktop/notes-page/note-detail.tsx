import { useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react"
import { Dialog } from "@base-ui/react/dialog"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { NoteEditor } from "./note-editor"
import { cn } from "@renderer/lib/utils"

export function NoteDetail({
  open,
  onClose,
  onExitComplete,
  returnFocus,
  ...editorProps
}: ComponentProps<typeof NoteEditor> & {
  open: boolean
  onExitComplete: () => void
  returnFocus: RefObject<HTMLElement | null>
}): React.JSX.Element {
  const actionsRef = useRef<Dialog.Root.Actions | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [previousOpen, setPreviousOpen] = useState(open)
  const [exited, setExited] = useState(!open)
  const exitFinished = useRef(true)
  const openRef = useRef(open)
  const reduced = useReducedMotion()
  const transition = { duration: reduced ? 0 : 0.25 }
  // 新一次打开重置退出状态，不在 effect 中再触发一轮渲染。
  if (previousOpen !== open) {
    setPreviousOpen(open)
    if (open) setExited(false)
  }
  useLayoutEffect(() => {
    openRef.current = open
    if (open) {
      exitFinished.current = false
    }
  }, [open])
  const finishExit = (): void => {
    if (exitFinished.current) return
    exitFinished.current = true
    actionsRef.current?.unmount()
    setExited(true)
    onExitComplete()
  }

  return (
    <Dialog.Root
      open={open}
      actionsRef={actionsRef}
      onOpenChange={(next, details) => {
        if (!next) {
          details.preventUnmountOnClose()
          onClose()
        }
      }}
    >
      <Dialog.Portal keepMounted>
        {open || !exited ? (
          <AnimatePresence onExitComplete={finishExit}>
            {open ? (
              <motion.div
                key="note-detail"
                exit={{ opacity: 0 }}
                transition={transition}
                onAnimationComplete={() => {
                  if (!openRef.current) finishExit()
                }}
              >
                <Dialog.Backdrop
                  render={
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={transition}
                    />
                  }
                  className="fixed inset-0 z-50 bg-black/20 dark:bg-black/40"
                />
                <Dialog.Popup
                  ref={popupRef}
                  initialFocus={() => popupRef.current?.querySelector("textarea") ?? true}
                  finalFocus={() =>
                    returnFocus.current?.isConnected
                      ? returnFocus.current
                      : document.querySelector<HTMLButtonElement>('button[aria-label="新建便签"]')
                  }
                  render={<motion.div exit={{ opacity: 0 }} transition={transition} layoutRoot />}
                  className={cn(
                    "fixed top-1/2 left-1/2 z-50 w-[min(560px,calc(100vw-3rem),calc(100dvh-4rem))] -translate-x-1/2 -translate-y-1/2 outline-none",
                    editorProps.expanded && "w-[min(720px,calc(100vw-3rem),calc(100dvh-4rem))]"
                  )}
                >
                  <Dialog.Title className="sr-only">编辑便签</Dialog.Title>
                  <NoteEditor {...editorProps} onClose={() => actionsRef.current?.close()} />
                  <Dialog.Close className="sr-only">关闭便签详情</Dialog.Close>
                </Dialog.Popup>
              </motion.div>
            ) : null}
          </AnimatePresence>
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  )
}
