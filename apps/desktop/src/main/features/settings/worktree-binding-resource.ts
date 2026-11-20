import type { HttpTransport, SessionRecord } from "@rzx/client";
import { decodeClearedSessionWorktreeBinding, type ClearSessionWorktreeBindingInput } from "@vykor/protocol";

export class WorktreeBindingResource {
  constructor(private readonly transport: HttpTransport) {}

  async clearWorktreeBinding(sessionId: string, input: ClearSessionWorktreeBindingInput, options: { signal?: AbortSignal } = {}): Promise<SessionRecord> {
    const response = await this.transport.request<{ session: SessionRecord }>(`/sessions/${encodeURIComponent(sessionId)}/worktree-cleared`, { method: "POST", body: input, signal: options.signal });
    return decodeClearedSessionWorktreeBinding(response.session, sessionId);
  }
}
