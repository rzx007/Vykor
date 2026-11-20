import {
  HttpTransport,
  VykorClient,
  readSessionRuntimeConfig,
  type SessionRecord,
  type ApprovalMode,
  type WorkMode,
} from "@rzx/client";
import { AuthResource, ProviderResource, SystemResource } from "@vykor/daemon-admin/configuration";
import { KnowledgeResource } from "@vykor/daemon-admin/knowledge";
import { CommandCatalogResource, DevelopmentResource, ProjectResource } from "@vykor/daemon-admin/workspace";
import { PluginResource } from "@vykor/daemon-admin/plugins";

import type { FrontendConfig } from "../../types";
import type { SessionCommandAdmin } from "../commands/session-commands";

export interface DefaultRuntimeSettings {
  model: string;
  approvalMode?: ApprovalMode;
  workMode?: WorkMode;
  provider?: string;
  baseUrl?: string;
  apiFormat?: "anthropic" | "openai";
}

export function stringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function normalizeSessionMode(value: unknown): "coordinator" | null {
  return value === "coordinator" ? "coordinator" : null;
}

export function statusSessionMode(value: unknown): "coordinator" | "direct" {
  return normalizeSessionMode(value) ?? "direct";
}

export function shouldAutoActivateSession(
  session: SessionRecord,
  defaultModel: string,
  pluginsEnabled: boolean | undefined | null,
): boolean {
  const runtime = readSessionRuntimeConfig(session);
  return runtime.model === defaultModel
    && (pluginsEnabled == null || (runtime.pluginsEnabled ?? true) === pluginsEnabled);
}

export type TuiDaemonAdmin = SessionCommandAdmin & { catalog: Pick<CommandCatalogResource, "listCommands"> };

export function createDaemonConnection(daemon: FrontendConfig["daemon"]) {
  if (!daemon?.url) return null;
  const options = {
    baseUrl: daemon.url,
    token: daemon.token ?? undefined,
  };
  const client = new VykorClient(options);
  let admin: TuiDaemonAdmin | undefined;
  return {
    client,
    getAdmin(): TuiDaemonAdmin {
      if (admin) return admin;
      const transport = new HttpTransport(options);
      return admin = {
        system: new SystemResource(transport),
        knowledge: new KnowledgeResource(transport),
        catalog: new CommandCatalogResource(transport),
        providers: new ProviderResource(transport),
        auth: new AuthResource(transport),
        projects: new ProjectResource(transport),
        plugins: new PluginResource(transport),
        development: new DevelopmentResource(transport),
      };
    },
  };
}
