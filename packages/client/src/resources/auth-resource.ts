/**
 * AuthResource: 鉴权与第三方认证状态资源。
 */

import type { HttpTransport } from "../transport/http-transport.js";
import type { AuthStatus } from "../types/index.js";

export class AuthResource {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /auth` */
  async getStatus(
    options: { signal?: AbortSignal } = {},
  ): Promise<AuthStatus> {
    const response = await this.transport.request<{ auth: AuthStatus }>("/auth", {
      signal: options.signal,
    });
    return response.auth;
  }

  /** `POST /auth/login` */
  async login(
    input: { provider: string; apiKey?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.transport.request<{ message: string }>("/auth/login", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  /** `POST /auth/logout` */
  async logout(
    input: { provider: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<{ message: string }> {
    return await this.transport.request<{ message: string }>("/auth/logout", {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }
}
