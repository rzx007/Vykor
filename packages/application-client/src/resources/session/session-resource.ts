import { SessionResource as CoreSessionResource, type HttpTransport, type PromptResponse, type SessionRecord } from "@rzx/client";
import { decodeClearedSessionWorktreeBinding, decodeSessionStateSnapshot, type SessionStateSnapshot, type ClearSessionWorktreeBindingInput } from "@vykor/protocol";
import type { AppAdmitClientPromptInput } from "../../types/index.js";

/** 产品附件上下文与 Desktop worktree 维护；生命周期请求复用公开 SDK。 */
export class SessionResource extends CoreSessionResource {
  constructor(private readonly appTransport: HttpTransport) { super(appTransport); }

  override admitPrompt(sessionId: string, input: AppAdmitClientPromptInput, options: { signal?: AbortSignal } = {}): Promise<PromptResponse> {
    return super.admitPrompt(sessionId, input, options);
  }

  override async getState(sessionId: string, options: { signal?: AbortSignal; partView?: "summary" } = {}): Promise<SessionStateSnapshot> {
    const response = await this.appTransport.request<unknown>(
      this.appTransport.path(`/sessions/${encodeURIComponent(sessionId)}/state`, { partView: options.partView }),
      { signal: options.signal },
    );
    return decodeSessionStateSnapshot(response);
  }

  async clearWorktreeBinding(sessionId: string, input: ClearSessionWorktreeBindingInput, options: { signal?: AbortSignal } = {}): Promise<SessionRecord> {
    const response = await this.appTransport.request<{ session: SessionRecord }>(`/sessions/${encodeURIComponent(sessionId)}/worktree-cleared`, { method: "POST", body: input, signal: options.signal });
    return decodeClearedSessionWorktreeBinding(response.session, sessionId);
  }
}
