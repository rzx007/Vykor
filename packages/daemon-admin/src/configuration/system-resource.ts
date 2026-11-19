import type { HttpTransport } from "@rzx/client";
import type { OutputStyleInfo } from "./types.js";

export class SystemResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /settings` */
  async getSettings(
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.transport.request<{ settings: Record<string, unknown> }>(
      "/settings",
      { signal: options.signal },
    );
    return response.settings;
  }

  /** `PATCH /settings` */
  async patchSettings(
    patch: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.transport.request<{ settings: Record<string, unknown> }>(
      "/settings",
      {
        method: "PATCH",
        body: patch,
        signal: options.signal,
      },
    );
    return response.settings;
  }

  /** `GET /profile` */
  async getProfileStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const response = await this.transport.request<{ report: string }>("/profile", {
      signal: options.signal,
    });
    return response.report;
  }

  /** `POST /profile/init` */
  async initProfile(options: { signal?: AbortSignal } = {}): Promise<string> {
    const response = await this.transport.request<{ report: string }>(
      "/profile/init",
      {
        method: "POST",
        signal: options.signal,
      },
    );
    return response.report;
  }

  /** `GET /output-styles` */
  async listOutputStyles(
    options: { signal?: AbortSignal } = {},
  ): Promise<OutputStyleInfo[]> {
    const response = await this.transport.request<{ styles: OutputStyleInfo[] }>(
      "/output-styles",
      {
        signal: options.signal,
      },
    );
    return response.styles;
  }
}
