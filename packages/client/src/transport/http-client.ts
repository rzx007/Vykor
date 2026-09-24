/**
 * daemon HTTP/SSE 客户端。
 *
 * `VykorClient` 只组装当前领域 Resource；底层 transport 不作为实例 API 暴露。
 */

import type { VykorClientOptions } from "../types/index.js";
import {
  HttpTransport,
  VykorApiError,
  normalizeDaemonBaseUrl,
} from "./http-transport.js";
import {
  SseTransport,
  streamServerSentEvents,
} from "./sse-transport.js";
import {
  ProtocolClient,
  IncompatibleProtocolError,
} from "../protocol/index.js";
import {
  SystemResource,
  ProviderResource,
  AuthResource,
  ProjectResource,
  PluginResource,
  DevelopmentResource,
  SessionResource,
  AttachmentResource,
  PermissionResource,
  ScheduleResource,
  JobResource,
  TerminalResource,
  ChannelResource,
  EventResource,
  McpResource,
  createPromptRequestId,
} from "../resources/index.js";

export {
  HttpTransport,
  VykorApiError,
  normalizeDaemonBaseUrl,
  SseTransport,
  streamServerSentEvents,
  ProtocolClient,
  IncompatibleProtocolError,
  SystemResource,
  ProviderResource,
  AuthResource,
  ProjectResource,
  PluginResource,
  DevelopmentResource,
  SessionResource,
  AttachmentResource,
  PermissionResource,
  ScheduleResource,
  JobResource,
  TerminalResource,
  ChannelResource,
  EventResource,
  McpResource,
  createPromptRequestId,
};

/** 面向 daemon 的 typed fetch 客户端。 */
export class VykorClient {
  readonly protocol: ProtocolClient;
  readonly system: SystemResource;
  readonly providers: ProviderResource;
  readonly auth: AuthResource;
  readonly projects: ProjectResource;
  readonly plugins: PluginResource;
  readonly development: DevelopmentResource;
  readonly sessions: SessionResource;
  readonly attachments: AttachmentResource;
  readonly permissions: PermissionResource;
  readonly schedules: ScheduleResource;
  readonly jobs: JobResource;
  readonly terminals: TerminalResource;
  readonly channels: ChannelResource;
  readonly events: EventResource;
  readonly mcp: McpResource;

  constructor(options: VykorClientOptions) {
    const transport = new HttpTransport(options);
    const sse = new SseTransport(transport);
    this.protocol = new ProtocolClient(transport);
    this.system = new SystemResource(transport);
    this.providers = new ProviderResource(transport);
    this.auth = new AuthResource(transport);
    this.projects = new ProjectResource(transport);
    this.plugins = new PluginResource(transport);
    this.development = new DevelopmentResource(transport);
    this.sessions = new SessionResource(transport);
    this.attachments = new AttachmentResource(transport);
    this.permissions = new PermissionResource(transport);
    this.schedules = new ScheduleResource(transport);
    this.jobs = new JobResource(transport);
    this.terminals = new TerminalResource(transport, sse);
    this.channels = new ChannelResource(transport);
    this.events = new EventResource(transport, sse);
    this.mcp = new McpResource(transport);
  }
}
