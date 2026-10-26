/** 存储只接收数据身份；不依赖工具定义、执行函数、环境或框架运行上下文。 */
export interface StoredToolOperationIntent {
  scope: {
    sessionId: string;
    runId: string;
    agentId: string;
    inputId: string;
    traceId: string;
    cwd: string;
    /** 只用于本次派发取消检查，不写入记录。 */
    signal?: AbortSignal;
  };
  toolUse: {
    type?: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
  parentOperationId?: string;
  generationId?: string;
}
