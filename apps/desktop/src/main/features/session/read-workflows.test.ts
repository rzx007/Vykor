import { expect, it } from "vitest"
import type { VykorClient, JobSnapshot } from "@vykor/client"
import { readDesktopWorkflows } from "./read-workflows"

it("retains a workflow with unavailable details instead of dropping its failed read", async () => {
  const job: JobSnapshot = {
    id: "workflow:w",
    kind: "workflow",
    ownerSession: "main",
    label: "修复",
    status: "running",
    cwd: "/repo",
    startedAt: 1,
    updatedAt: 2,
    capabilities: { read: true, wait: true, send: false, cancel: true },
  }
  const client = {
    jobs: {
      list: async () => [job],
      read: async () => {
        throw new Error("offline")
      },
    },
  } as unknown as Pick<VykorClient, "jobs">
  const snapshot = await readDesktopWorkflows(client, "main")
  expect(snapshot.runs).toHaveLength(1)
  expect(snapshot.runs[0]).toMatchObject({
    jobId: "workflow:w",
    status: "running",
    detailsAvailable: false,
  })
  expect(snapshot.errors).toEqual([{ jobId: "workflow:w", message: "offline" }])
})

it("does not expose jobs outside the requested session or kind", async () => {
  const client = {
    jobs: {
      list: async () => [
        { kind: "workflow", ownerSession: "other" },
        { kind: "agent", ownerSession: "main" },
      ],
    },
  } as unknown as Pick<VykorClient, "jobs">
  expect((await readDesktopWorkflows(client, "main")).runs).toEqual([])
})
