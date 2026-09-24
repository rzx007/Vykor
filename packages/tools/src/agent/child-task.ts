import type { AgentChildController } from "@vykor/core";
import type { AwaitExecutionResult } from "@vykor/services";

export async function awaitFrameworkChildTask(
  children: AgentChildController,
  taskId: string,
  timeoutMs?: number,
): Promise<AwaitExecutionResult> {
  const completion = children.awaitChildAgent(taskId).then((result): AwaitExecutionResult => ({
    status: result.status === "interrupted" ? "stopped" : result.status,
    output: result.output || result.error || "",
    failureKind: result.status,
  }));
  if (timeoutMs === undefined) return completion;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<AwaitExecutionResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "running", output: "", timedOut: true }),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
