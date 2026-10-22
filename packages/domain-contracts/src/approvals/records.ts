import type { ApprovalReviewResult } from "@vykor/agent-contracts/permissions";
export interface ApprovalReviewRecord {
  status: "reviewing" | "approved" | "ask_user" | "denied" | "timed_out";
  startedAt: number;
  completedAt?: number;
  reason?: string;
  result?: ApprovalReviewResult;
}
