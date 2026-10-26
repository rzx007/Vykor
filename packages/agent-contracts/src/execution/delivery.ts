/** Agent-reported progress; format validity alone does not prove completion. */
export interface StructuredDelivery {
  status: "done" | "partial" | "blocked" | "waiting";
  summary: string;
  data: unknown;
}
export interface DeliveryReceipt extends StructuredDelivery {
  validation: "schema_valid";
  verification: "not_requested" | "passed";
}
/** Trusted SDK/host contract; verify is never accepted from a serialized request. */
export interface AgentOutputContract {
  schema: Record<string, unknown>;
  verify?(delivery: StructuredDelivery): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
}
