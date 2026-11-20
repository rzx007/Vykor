import type { HttpTransport } from "@rzx/client";

export class ProjectResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `POST /project/init` */
  async init(
    input: { cwd: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.transport.request<{ report: string }>("/project/init", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
    return response.report;
  }
}
