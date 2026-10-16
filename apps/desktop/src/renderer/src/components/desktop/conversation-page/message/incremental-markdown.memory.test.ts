import { randomUUID } from "node:crypto"
import { getHeapSnapshot } from "node:v8"
import { expect, it } from "vitest"
import { createIncrementalMarkdownParser } from "./incremental-markdown"

interface HeapSnapshot {
  snapshot: { meta: { node_fields: string[]; node_types: (string[] | string)[] } }
  nodes: number[]
  strings: string[]
}

it("does not retain an old full reply behind each frozen paragraph", async () => {
  const marker = `markdown-backing-${randomUUID()}::`
  const parse = createIncrementalMarkdownParser()
  let text = `${marker}\n\n`
  for (let index = 0; index < 200; index++) {
    text += `Paragraph ${index}: ${"retained content ".repeat(6)}\n\n`
    parse(text)
  }
  const chunks: Buffer[] = []
  for await (const chunk of getHeapSnapshot()) chunks.push(Buffer.from(chunk))
  const heap = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HeapSnapshot
  const fields = heap.snapshot.meta.node_fields
  const types = heap.snapshot.meta.node_types[fields.indexOf("type")] as string[]
  let retainedBytes = 0
  for (let index = 0; index < heap.nodes.length; index += fields.length) {
    if (types[heap.nodes[index + fields.indexOf("type")]!] !== "string") continue
    const value = heap.strings[heap.nodes[index + fields.indexOf("name")]!]!
    if (value.startsWith(marker)) retainedBytes += heap.nodes[index + fields.indexOf("self_size")]!
  }
  // Keep the parser alive through the snapshot; a cache leak must not disappear with its owner.
  expect(parse(text).join("")).toBe(text)
  expect(retainedBytes).toBeLessThan(text.length * 8)
})
