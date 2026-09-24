import type { TerminalReadResult } from "@vykor/terminal"

const defaultMaxCharacters = 200_000

export class TerminalOutputStore {
  private chunks: Array<{ sequence: number; data: string }> = []
  private characters = 0
  private sequence = 0
  private truncated = false

  constructor(private readonly maxCharacters = defaultMaxCharacters) {}

  append(terminalId: string, data: string): TerminalReadResult {
    this.sequence += 1
    this.chunks.push({ sequence: this.sequence, data })
    this.characters += data.length

    while (this.characters > this.maxCharacters && this.chunks.length > 0) {
      const overflow = this.characters - this.maxCharacters
      const first = this.chunks[0]!
      if (first.data.length <= overflow) {
        this.chunks.shift()
        this.characters -= first.data.length
      } else {
        first.data = first.data.slice(overflow)
        this.characters -= overflow
      }
      this.truncated = true
    }

    return this.read(terminalId)
  }

  read(terminalId: string, options: { after?: number; maxChars?: number } = {}): TerminalReadResult {
    const firstSequence = this.chunks[0]?.sequence ?? this.sequence + 1
    const after = options.after
    let data = this.chunks
      .filter((chunk) => after === undefined || chunk.sequence > after)
      .map((chunk) => chunk.data)
      .join("")
    let truncated = this.truncated && (after === undefined || after < firstSequence)
    if (options.maxChars !== undefined && data.length > options.maxChars) {
      data = data.slice(-options.maxChars)
      truncated = true
    }
    return {
      terminalId,
      data,
      sequence: this.sequence,
      truncated,
    }
  }
}
