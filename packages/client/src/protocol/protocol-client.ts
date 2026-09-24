/**
 * ProtocolClient: 协议协商与健康检查客户端。
 *
 * 负责：
 * - GET /health 服务健康探测 (无需鉴权)
 * - GET /capabilities 服务协议能力探测与版本协商 (无需鉴权)
 * - 协议兼容性断言与 IncompatibleProtocolError 抛出
 *
 * 约束：
 * - 构造只接收 HttpTransport
 * - 业务请求的强制握手由 HttpTransport 缓存并执行
 */

import type {
  ClientProtocolSupport,
  ServerCapabilities,
} from "@vykor/protocol";
import {
  checkProtocolCompatibility,
  CURRENT_PROTOCOL_VERSION,
  parseServerCapabilities,
} from "@vykor/protocol";
import type { HttpTransport } from "../transport/http-transport.js";
import type { VykorServerHealth } from "../types/index.js";

export class IncompatibleProtocolError extends Error {
  constructor(
    readonly capabilities: ServerCapabilities,
    message: string,
  ) {
    super(message);
    this.name = "IncompatibleProtocolError";
  }
}

export interface CapabilitiesOptions {
  signal?: AbortSignal;
  support?: ClientProtocolSupport;
}

export interface HealthOptions {
  signal?: AbortSignal;
}

export class ProtocolClient {
  constructor(private readonly transport: HttpTransport) {}

  /** `GET /health` */
  async health(options: HealthOptions = {}): Promise<VykorServerHealth> {
    return this.transport.request<VykorServerHealth>("/health", {
      auth: false,
      signal: options.signal,
    });
  }

  /**
   * `GET /capabilities`
   * 连接产品应先调用它，再根据 features 决定显示哪些功能。
   */
  async capabilities(
    options: CapabilitiesOptions = {},
  ): Promise<ServerCapabilities> {
    const value = await this.transport.request<unknown>("/capabilities", {
      auth: false,
      signal: options.signal,
    });
    const capabilities = parseServerCapabilities(value);
    const compatibility = checkProtocolCompatibility(
      capabilities,
      options.support ?? { version: CURRENT_PROTOCOL_VERSION },
    );
    if (!compatibility.compatible) {
      throw new IncompatibleProtocolError(
        capabilities,
        compatibility.reason ??
          "Client and server protocol versions are incompatible",
      );
    }
    return capabilities;
  }
}
