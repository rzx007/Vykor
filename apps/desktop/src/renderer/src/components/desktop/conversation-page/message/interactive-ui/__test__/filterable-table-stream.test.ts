import { expect, it } from "vitest"
import { createInteractiveTableReader } from "../openui-library"

const heading = 'root = FilterableTable("结果", ["名称", "分数"]'

it("shows only literal rows with a closing bracket in the source", () => {
  const read = createInteractiveTableReader()
  expect(read(heading.slice(0, -1), false)).toBeNull()
  expect(read(heading, false)).toEqual({ title: "结果", columns: ["名称", "分数"], rows: [] })

  const firstRow = JSON.stringify(['有 ] 和 " 符号', 10])
  const nextRow = JSON.stringify(["乙", 20])
  const first = heading + ", [" + firstRow
  expect(read(first + ', ["到了 ] 但字符串没结束', false)?.rows).toEqual([['有 ] 和 " 符号', 10]])
  expect(read(first + ', ["乙", 2', false)?.rows).toEqual([['有 ] 和 " 符号', 10]])
  expect(read(first + ", " + nextRow, false)?.rows).toEqual([
    ['有 ] 和 " 符号', 10],
    ["乙", 20],
  ])
  expect(read(first + ", " + nextRow + "])", true)?.rows).toEqual([
    ['有 ] 和 " 符号', 10],
    ["乙", 20],
  ])
})

it("requires literal values and matching row widths, including on final validation", () => {
  const read = createInteractiveTableReader()
  expect(read(heading + ', [["甲", +10]', false)).toBeNull()
  expect(read(heading + ', [["甲"]', false)).toBeNull()
  expect(read(heading + ', [["甲", 10], ["乙",', false)?.rows).toEqual([["甲", 10]])
  expect(read(heading + ', [["甲", 10], ["乙",', true)).toBeNull()
  expect(read(heading + ', [["甲", 10], ["乙", 2]]) unexpected', true)).toBeNull()
  expect(read(heading + ', [["甲", 10]])', true)?.rows).toEqual([["甲", 10]])
})
