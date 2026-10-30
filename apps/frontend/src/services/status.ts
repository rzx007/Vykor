/**
 * 解析后端 state_snapshot 的 status 字段。
 *
 * status 是 Record<string, unknown>（协议宽松），此前 App / Footer / Sidebar /
 * AppView 各自 String(status.x ?? ...) 解析，默认值还不统一。集中到这里：
 * mode 统一缺省 "ask"，token 统一 Number(... ?? 0)。
 */
import { normalizeApprovalMode } from "@vykor/application-client";
export interface ParsedStatus {
  /** 授权档位，缺省 "ask" */
  mode: string;
  model: string;
  /** 推理强度（空串表示无） */
  effort: string;
  inputTokens: number;
  outputTokens: number;
}

export function parseStatus(status: Record<string, unknown>): ParsedStatus {
  return {
    mode: normalizeApprovalMode(status.approval_mode ?? status.permission_mode) ?? "ask",
    model: String(status.model ?? ""),
    effort: String(status.effort ?? ""),
    inputTokens: Number(status.input_tokens ?? 0),
    outputTokens: Number(status.output_tokens ?? 0),
  };
}
