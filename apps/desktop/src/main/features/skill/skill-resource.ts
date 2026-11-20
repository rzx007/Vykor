import type { HttpTransport } from "@rzx/client";
import type { SkillMarketplaceEntry, SkillMarketplaceInstallInput } from "@vykor/protocol";
import type { SkillSnapshot } from "@rzx/client";

export class SkillResource {
  constructor(private readonly transport: HttpTransport) {}

  async listSkillMarketplace(): Promise<SkillMarketplaceEntry[]> {
    return await this.transport.request<SkillMarketplaceEntry[]>("/skills/marketplace");
  }

  async installMarketplaceSkill(input: SkillMarketplaceInstallInput): Promise<SkillSnapshot> {
    return await this.transport.request<SkillSnapshot>("/skills/marketplace/install", {
      method: "POST",
      body: input,
    });
  }

  /** `DELETE /skills/:id` */
  async removeSkill(
    id: string,
    input: { expectedContent: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<SkillSnapshot> {
    return await this.transport.request<SkillSnapshot>(
      `/skills/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        body: input,
        signal: options.signal,
      },
    );
  }

}
