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
 * - 无全局或内存隐式状态缓存
 * - 业务 Resource 不得隐式触发协商请求
 */

import type {
  ClientProtocolSupport,
  ServerCapabilities,
} from "@openharness/protocol";
import {
  checkProtocolCompatibility,
  CURRENT_PROTOCOL_VERSION,
  parseServerCapabilities,
} from "@openharness/protocol";
import type { HttpTransport } from "../transport/http-transport.js";
import type { OpenHarnessServerHealth } from "../types/index.js";

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
  async health(options: HealthOptions = {}): Promise<OpenHarnessServerHealth> {
    return this.transport.request<OpenHarnessServerHealth>("/health", {
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
