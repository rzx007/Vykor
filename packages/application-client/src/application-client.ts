/** 产品客户端：共用 SDK 连接与生命周期资源，组装应用业务接口。 */
import { HttpTransport, SseTransport, ProtocolClient, RuntimeResource, PermissionResource, JobResource, EventResource, FilesResource, type VykorClientOptions } from "@rzx/client";
import { SystemResource, ProviderResource, AuthResource, ProjectResource, PluginResource, PluginUiHistoryResource, DevelopmentResource, SessionResource, AttachmentResource, ScheduleResource, NoteResource, TerminalResource, ChannelResource, McpResource } from "./resources/index.js";
import { PluginAppResource } from "./resources/plugins/plugin-app-resource.js";

export class VykorClient {
  readonly pluginUiHistory: PluginUiHistoryResource;
  readonly pluginApps: PluginAppResource;
  readonly protocol: ProtocolClient;
  readonly runtime: RuntimeResource;
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
  readonly notes: NoteResource;
  readonly jobs: JobResource;
  readonly terminals: TerminalResource;
  readonly channels: ChannelResource;
  readonly events: EventResource;
  readonly mcp: McpResource;
  readonly files: FilesResource;

  constructor(options: VykorClientOptions) {
    const transport = new HttpTransport(options);
    const sse = new SseTransport(transport);
    this.protocol = new ProtocolClient(transport);
    this.runtime = new RuntimeResource(transport);
    this.system = new SystemResource(transport);
    this.providers = new ProviderResource(transport);
    this.auth = new AuthResource(transport);
    this.projects = new ProjectResource(transport);
    this.plugins = new PluginResource(transport);
    this.pluginUiHistory = new PluginUiHistoryResource(transport);
    this.pluginApps = new PluginAppResource(transport);
    this.development = new DevelopmentResource(transport);
    this.sessions = new SessionResource(transport);
    this.attachments = new AttachmentResource(transport);
    this.permissions = new PermissionResource(transport);
    this.schedules = new ScheduleResource(transport);
    this.notes = new NoteResource(transport);
    this.jobs = new JobResource(transport);
    this.terminals = new TerminalResource(transport, sse);
    this.channels = new ChannelResource(transport);
    this.events = new EventResource(transport, sse);
    this.mcp = new McpResource(transport);
    this.files = new FilesResource(transport);
  }
}
