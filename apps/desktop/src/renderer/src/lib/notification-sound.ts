const sources = import.meta.glob<string>("../assets/audio/*.mp3", {
  eager: true,
  query: "?url&no-inline",
  import: "default",
})

let playing: HTMLAudioElement | undefined

export async function playNotificationSound(id: string): Promise<void> {
  const source = sources[`../assets/audio/${id}.mp3`]
  if (!source) return
  if (typeof Audio === "undefined") return
  try {
    playing?.pause()
    const audio = new Audio(source)
    playing = audio
    audio.volume = 0.5
    await audio.play()
  } catch {
    // 音效播放失败不影响任务结果或系统通知。
  }
}
