import type { ProjectionSettlementAction, ProjectionSettlementStatus } from "@vykor/domain-contracts/sessions";
export interface CreateProjectionSettlementInput {
  id?: string;
  projector: string;
  rootSessionId: string;
  eventSequence: number;
  action: ProjectionSettlementAction;
  payload: Record<string, unknown>;
  error?: string;
}

export interface ListProjectionSettlementsOptions {
  projector?: string;
  rootSessionId?: string;
  status?: ProjectionSettlementStatus | readonly ProjectionSettlementStatus[];
}
