import type { AgentOutputContract, AgentRunContribution, DeliveryReceipt, StructuredDelivery, ToolResult } from "@vykor/agent-contracts";
import { validateToolInput } from "@vykor/core/engine";
import { assertJsonData, assertSupportedOutputSchema } from "./schema.js";

export interface StructuredDeliveryController {
  contribution: AgentRunContribution;
  getReceipt(): DeliveryReceipt | undefined;
  requireReceipt(): DeliveryReceipt;
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
const failed = (reason: string): ToolResult => ({ content: [{ type: "text", text: reason }], isError: true, executionState: "not_started", failureKind: "invalid_input" });

export function createStructuredDelivery(contract: AgentOutputContract): StructuredDeliveryController {
  assertSupportedOutputSchema(contract.schema);
  const schema = structuredClone(contract.schema);
  const envelope = { type: "object", properties: {
    status: { type: "string", enum: ["done", "partial", "blocked", "waiting"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 }, data: schema,
  }, required: ["status", "summary", "data"], additionalProperties: false };
  let accepted: DeliveryReceipt | undefined;
  let prepared: { key: string; receipt: DeliveryReceipt } | undefined;
  let validating = false;
  const validate = async (input: Record<string, unknown>): Promise<string | undefined> => {
    if (accepted) return "A structured delivery has already been recorded for this Run.";
    if (validating) return "Another delivery is being verified; wait for its result.";
    validating = true;
    try {
      assertJsonData(input);
      const invalid = validateToolInput(envelope, input);
      if (invalid) return invalid;
      const candidate = structuredClone(input) as unknown as StructuredDelivery;
      freeze(candidate);
      const verification = contract.verify ? await contract.verify(candidate) : undefined;
      if (contract.verify && verification?.ok !== true) return verification?.reason?.slice(0, 1000) || "Host verification rejected this delivery.";
      prepared = { key: JSON.stringify(input), receipt: { ...candidate, validation: "schema_valid", verification: contract.verify ? "passed" : "not_requested" } };
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message.slice(0, 1000) : "Delivery validation failed.";
    } finally { validating = false; }
  };
  const tool = {
    name: "SubmitResult", description: "Submit the final structured delivery required by this Run. Use it alone after all other work and checks. done is a task status, not proof of business verification.",
    safeToRetry: true,
    inputSchema: envelope,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      if (accepted) return failed("A structured delivery has already been recorded for this Run.");
      let key: string;
      try { assertJsonData(input); key = JSON.stringify(input); } catch { return failed("Delivery must contain only JSON data."); }
      if (!prepared || prepared.key !== key) { const reason = await validate(input); if (reason) return failed(reason); }
      if (!prepared || prepared.key !== key) return failed("Delivery changed after verification.");
      accepted = structuredClone(prepared.receipt);
      prepared = undefined;
      return { content: [{ type: "text", text: JSON.stringify(accepted) }], executionState: "completed" };
    },
  };
  return {
    contribution: {
      systemGuidance: "本轮要求结构化交付。完成实际工作和必要检查后，单独调用 SubmitResult，提交 status、summary、data。结构或宿主核验失败时根据原因修正；不要用普通最终文本代替交付。done/partial/blocked/waiting 表示任务进展，格式有效不代表业务已经验收。",
      tools: [{ definition: tool, permission: "host-internal", endRunOnSuccess: true, requiresSoloBatch: true, beforeDispatch: input => validate(input) }],
    },
    getReceipt: () => accepted && structuredClone(accepted),
    requireReceipt: () => { if (!accepted) throw new Error("The Run ended without a valid structured delivery."); return structuredClone(accepted); },
  };
}
