/** Remote Agent lifecycle client. Constructing it never starts or changes a daemon. */
import type { VykorClientOptions } from "../types/index.js";
import { HttpTransport } from "./http-transport.js";
import { SseTransport } from "./sse-transport.js";
import { ProtocolClient } from "../protocol/index.js";
import { RuntimeResource, SessionResource, AttachmentResource, PermissionResource, JobResource, EventResource, FilesResource } from "../resources/index.js";

export class VykorClient {
  readonly protocol: ProtocolClient;
  readonly runtime: RuntimeResource;
  readonly sessions: SessionResource;
  readonly attachments: AttachmentResource;
  readonly permissions: PermissionResource;
  readonly jobs: JobResource;
  readonly events: EventResource;
  readonly files: FilesResource;

  constructor(options: VykorClientOptions) {
    const transport = new HttpTransport(options);
    const sse = new SseTransport(transport);
    this.protocol = new ProtocolClient(transport);
    this.runtime = new RuntimeResource(transport);
    this.sessions = new SessionResource(transport);
    this.attachments = new AttachmentResource(transport);
    this.permissions = new PermissionResource(transport);
    this.jobs = new JobResource(transport);
    this.events = new EventResource(transport, sse);
    this.files = new FilesResource(transport);
  }
}
