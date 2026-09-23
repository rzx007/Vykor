import { ChannelConfigStore } from "@openharness/auth";
import { loadSettings } from "@openharness/core";

import {
  createDefaultApplicationServices,
  type DaemonSettingsRef,
} from "../application/default-application-services.js";
import { createDefaultCommandCatalog } from "../commands/default-command-catalog.js";
import {
  startOpenHarnessServer,
  type OpenHarnessServerOptions,
} from "../http/server.js";

export type OpenHarnessDaemonOptions = Pick<
  OpenHarnessServerOptions,
  | "allowedOrigins"
  | "channelConfigStore"
  | "host"
  | "logger"
  | "outsideProjectWorkspaceRoot"
  | "port"
  | "store"
  | "storePath"
  | "token"
  | "version"
  | "executionSurface"
  | "browserHost"
>;

/** Starts the opinionated daemon application with all standard resource services installed. */
export async function startOpenHarnessDaemon(
  options: OpenHarnessDaemonOptions = {},
) {
  const settingsRef: DaemonSettingsRef = {
    current: await loadSettings({}),
    async reload() {
      return await loadSettings({});
    },
  };
  const startupAgentEnvironment = settingsRef.current.agentEnvironment;
  return await startOpenHarnessServer({
    ...options,
    channelConfigStore: options.channelConfigStore ?? new ChannelConfigStore(),
    settings: settingsRef.current,
    getSettings: () => settingsRef.current,
    getSettingsForCwd: async (cwd) => ({
      ...(await loadSettings(undefined, {
        includeProject: true,
        projectRoot: cwd,
      })),
      agentEnvironment: startupAgentEnvironment,
    }),
    services: {
      commandCatalog: createDefaultCommandCatalog(() => settingsRef.current),
      ...createDefaultApplicationServices(settingsRef),
    },
  });
}
