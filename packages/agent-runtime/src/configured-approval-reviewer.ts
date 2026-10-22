import type { Settings } from "@vykor/host-config";
import { createApprovalReviewer, type ApprovalReviewer } from "./approval-reviewer.js";
import { resolveApiClient } from "./default-runtime-provider.js";

export interface ConfiguredApprovalReviewerOptions {
  settings: Settings;
  model: string;
  provider?: string;
  baseUrl?: string;
  apiFormat?: "anthropic" | "openai";
  sessionId?: string;
}

/** Provider and credential resolution remain inside the runtime package. */
export async function createConfiguredApprovalReviewer(
  options: ConfiguredApprovalReviewerOptions,
): Promise<ApprovalReviewer> {
  const { settings, sessionId, ...configuration } = options;
  const client = await resolveApiClient(settings, configuration, undefined, sessionId);
  return createApprovalReviewer({ client, model: configuration.model });
}
