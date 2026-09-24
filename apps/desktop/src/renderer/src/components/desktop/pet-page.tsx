import { Blobatar } from "@blobatar/react"
import { useEffect, useRef, useState } from "react"
import "blobatar/motion.css"

const singleClickDelayMs = 280

export function PetWindow(): React.JSX.Element {
  const [blobatarName, setBlobatarName] = useState(() => crypto.randomUUID())
  const clickTimerRef = useRef<number | null>(null)

  const switchAvatar = (): void => {
    setBlobatarName(crypto.randomUUID())
  }

  const cancelPendingClick = (): void => {
    if (clickTimerRef.current === null) return
    window.clearTimeout(clickTimerRef.current)
    clickTimerRef.current = null
  }

  useEffect(() => {
    return window.desktop.pet.onClicked(switchAvatar)
  }, [])

  useEffect(() => () => cancelPendingClick(), [])

  return (
    <main
      data-pet-window
      className="grid h-screen w-screen place-items-center bg-transparent"
      aria-label="Vykor 桌面宠物"
    >
      <button
        type="button"
        className="titlebar-drag grid size-full cursor-pointer place-items-center bg-transparent"
        aria-label="单击切换头像，双击打开主窗口"
        onClick={() => {
          cancelPendingClick()
          clickTimerRef.current = window.setTimeout(() => {
            clickTimerRef.current = null
            switchAvatar()
          }, singleClickDelayMs)
        }}
        onDoubleClick={() => {
          cancelPendingClick()
          void window.desktop.window.showMain()
        }}
      >
        <Blobatar name={blobatarName} animate="always" size={100} />
      </button>
    </main>
  )
}
