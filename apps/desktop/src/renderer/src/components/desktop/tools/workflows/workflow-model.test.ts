import { expect, it } from "vitest"
import type { DesktopWorkflowRun } from "@shared/workflow-types"
import {
  layoutWorkflow,
  workflowImpact,
  workflowCounts,
  workflowToolRunId,
  workflowOutputFiles,
} from "./workflow-model"

const run = {
  tasks: [
    { id: "a", dependencies: [], status: "completed" },
    { id: "b", dependencies: ["a"], status: "failed" },
    { id: "c", dependencies: ["a"], status: "running" },
    { id: "d", dependencies: ["b", "c"], status: "skipped" },
  ],
} as DesktopWorkflowRun

it("keeps graph positions stable across status changes and places join nodes after their dependencies", () => {
  const graph = layoutWorkflow(run.tasks)
  expect(graph.nodes.map((n) => [n.id, n.column])).toEqual([
    ["a", 0],
    ["b", 1],
    ["c", 1],
    ["d", 2],
  ])
  expect(layoutWorkflow(run.tasks.map((t) => ({ ...t, status: "completed" }))).nodes).toEqual(
    graph.nodes
  )
})

it("highlights only descendants, keeping a parallel sibling outside the failure impact", () => {
  expect([...workflowImpact(run.tasks, "b")]).toEqual(["d"])
  expect(workflowCounts(run)).toMatchObject({
    completed: 1,
    failed: 1,
    skipped: 1,
    running: 1,
    total: 4,
  })
})

it("identifies a detached receipt without parsing worker prose or matching a different tool kind", () => {
  expect(
    workflowToolRunId({
      content: [
        {
          type: "text",
          text: '{"kind":"job","jobKind":"workflow","jobId":"workflow:w1","action":"created"}',
        },
      ],
    })
  ).toBe("w1")
  expect(
    workflowToolRunId('{"kind":"job","jobKind":"agent","jobId":"workflow:w1"}')
  ).toBeUndefined()
  expect(workflowToolRunId("Completed workflow:w1")).toBeUndefined()
})

it("reads the actual escaped synchronous Workflow notification envelope", () => {
  // The real formatter's full-schema and large-body contract is covered by server/part-wire-view.test.ts.
  const notification =
    "<workflow-notification>\n<payload>{&quot;runId&quot;:&quot;sync-run&quot;,&quot;status&quot;:&quot;completed&quot;,&quot;summary&quot;:&quot;&lt;hello&gt;&amp;&quot;,&quot;tasks&quot;:[]}</payload>\n</workflow-notification>"
  expect(workflowToolRunId(notification)).toBe("sync-run")
})

it("offers only complete absolute file references from returned text, without inventing verified artifacts", () => {
  expect(
    workflowOutputFiles({
      result: [
        "- 路径：`C:\\Users\\ruanz\\Documents\\report.md`",
        "- 重复：`C:/Users/ruanz/Documents/report.md`",
        "- 文件：`/tmp/交付/presentation.pptx`",
        "- 目录：`C:\\Users\\ruanz\\Documents`",
        "- 截断：`...\\skills\\write\\SKILL.md`",
        "- 示例：`C:\\...\\report.md`",
        "- 命令：`Get-Item C:\\Users\\ruanz\\Documents\\report.md`",
        "- URL：`https://example.com/report.md`",
      ].join("\n"),
    } as DesktopWorkflowRun["tasks"][number])
  ).toEqual(["C:\\Users\\ruanz\\Documents\\report.md", "/tmp/交付/presentation.pptx"])
})
