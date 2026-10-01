export type ComposerTriggerMode = "leading" | "inline"

export interface ComposerTrigger {
  sigil: "/" | "$" | "@"
  query: string
  from: number
  to: number
  mode: ComposerTriggerMode
}

const queryCharacter = /[A-Za-z0-9._:\u3400-\u9fff-]/
const asciiWhitespace = /[ \t\n\r\f\v]/

/** Finds the slash/dollar token containing the given UTF-16 cursor offset. */
export function findComposerTrigger(
  text: string,
  cursor: number,
  options?: { atomicBoundaries?: readonly number[] }
): ComposerTrigger | null {
  if (!Number.isInteger(cursor) || cursor < 1 || cursor > text.length) return null

  let queryStart = cursor
  while (queryStart > 0 && queryCharacter.test(text[queryStart - 1] ?? "")) queryStart -= 1

  const sigilIndex = queryStart - 1
  const sigil = text[sigilIndex]
  if (sigil !== "/" && sigil !== "$" && sigil !== "@") return null

  const preceding = text[sigilIndex - 1]
  if (
    sigilIndex > 0 &&
    !asciiWhitespace.test(preceding ?? "") &&
    !options?.atomicBoundaries?.includes(sigilIndex)
  )
    return null

  const end = scanTokenEnd(text, sigilIndex + 1)
  if (cursor > end) return null

  // A doubled sigil is ordinary text (e.g. //path or $$HOME).
  if (text[sigilIndex + 1] === sigil) return null

  return {
    sigil,
    query: text.slice(sigilIndex + 1, end),
    from: sigilIndex,
    to: end,
    mode: text.slice(0, sigilIndex).trim() === "" ? "leading" : "inline",
  }
}

function scanTokenEnd(text: string, start: number): number {
  let end = start
  while (end < text.length && queryCharacter.test(text[end] ?? "")) end += 1
  return end
}
