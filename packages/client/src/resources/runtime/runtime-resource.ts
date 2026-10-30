import type { HttpTransport } from "../../transport/http-transport.js";
import type { AgentPersonaInfo, McpServerStatus, ModelProviderInfo, SkillSnapshot } from "../../types/index.js";

/** Read capabilities already configured on the daemon; no installation or global mutations. */
export class RuntimeResource {
  constructor(private readonly transport: HttpTransport) {}

  async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelProviderInfo[]> {
    const response = await this.transport.request<{ providers: ModelProviderInfo[] }>("/models", options);
    return response.providers;
  }

  async listAgentPersonas(options: { signal?: AbortSignal } = {}): Promise<AgentPersonaInfo[]> {
    const response = await this.transport.request<{ agents: AgentPersonaInfo[] }>("/agent-personas", options);
    return response.agents;
  }

  listSkills(options: { signal?: AbortSignal } = {}): Promise<SkillSnapshot> {
    return this.transport.request<SkillSnapshot>("/skills", options);
  }

  async getSessionMcp(sessionId: string, options: { signal?: AbortSignal } = {}): Promise<McpServerStatus[]> {
    const response = await this.transport.request<{ servers: McpServerStatus[] }>(`/sessions/${encodeURIComponent(sessionId)}/mcp`, options);
    return response.servers;
  }
}
