import type { VykorClient } from "@vykor/client"
import { projectWorkflowRun } from "../../../shared/workflow-projection"
import type { DesktopWorkflowSnapshot } from "../../../shared/workflow-types"

export async function readDesktopWorkflows(
  client: Pick<VykorClient, "jobs">,
  sessionId: string,
  selectedJobId?: string
): Promise<DesktopWorkflowSnapshot> {
  const jobs = (
    await client.jobs.list({ sessionId, kinds: ["workflow"], includeFinished: true, limit: 51 })
  ).filter((job) => job.kind === "workflow" && job.ownerSession === sessionId)
  const errors: DesktopWorkflowSnapshot["errors"] = []
  const runs = await Promise.all(
    jobs.slice(0, 50).map(async (job) => {
      try {
        const read = await client.jobs.read(job.id, { sessionId, maxChars: 1 })
        if (
          read.snapshot.ownerSession !== sessionId ||
          read.snapshot.kind !== "workflow" ||
          read.snapshot.id !== job.id
        )
          throw new Error("编排归属发生变化，请重新打开会话。")
        return projectWorkflowRun(read)
      } catch (error) {
        errors.push({
          jobId: job.id,
          message: error instanceof Error ? error.message : String(error),
        })
        return projectWorkflowRun({ snapshot: job, text: "", cursor: 0, truncated: false })
      }
    })
  )
  if (selectedJobId && !runs.some((run) => run.jobId === selectedJobId)) {
    try {
      const read = await client.jobs.read(selectedJobId, { sessionId, maxChars: 1 })
      if (
        read.snapshot.ownerSession !== sessionId ||
        read.snapshot.kind !== "workflow" ||
        read.snapshot.id !== selectedJobId
      )
        throw new Error("编排不属于当前会话。")
      runs.push(projectWorkflowRun(read))
    } catch (error) {
      errors.push({
        jobId: selectedJobId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    sessionId,
    runs: runs.sort((a, b) => b.startedAt - a.startedAt),
    hasMore: jobs.length > 50,
    errors,
  }
}
