export type OutputFlush = (data: string) => void

export class OutputBuffer {
  private buffer = ""
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly flush: OutputFlush,
    private readonly delayMs = 16
  ) {}

  push(data: string): void {
    this.buffer += data
    if (this.timer) return
    this.timer = setTimeout(() => this.drain(), this.delayMs)
  }

  drain(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.buffer) return
    const data = this.buffer
    this.buffer = ""
    this.flush(data)
  }

  dispose(): void {
    this.drain()
  }
}
