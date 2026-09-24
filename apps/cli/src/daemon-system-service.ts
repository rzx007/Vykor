import {
  createDaemonAutoStartController,
  DaemonSystemService,
  type DaemonAutoStartController,
} from "@vykor/server/daemon-host";

import {
  resolveDaemonInvocation,
  type DaemonInvocationOptions,
} from "./daemon-process.js";

export {
  DaemonSystemService,
  serializeWindowsArguments,
  type DaemonServiceInvocation,
  type DaemonSystemServiceOptions,
  type DaemonSystemServiceState,
  type DaemonSystemServiceStatus,
  type SystemCommandResult,
} from "@vykor/server/daemon-host";

export interface CreateDaemonSystemServiceOptions extends DaemonInvocationOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  logsDir?: string;
  uid?: number;
  cwd?: string;
  runCommand?: ConstructorParameters<
    typeof DaemonSystemService
  >[0]["runCommand"];
}

export function createDaemonSystemService(
  entry: string,
  serveArgs: string[] = [
    "serve",
    "--register",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
  ],
  options: CreateDaemonSystemServiceOptions = {},
): DaemonSystemService {
  const platform = options.platform ?? process.platform;
  const invocationArgs =
    platform === "win32" ? ["daemon", "watchdog", ...serveArgs] : serveArgs;
  const invocation = resolveDaemonInvocation(entry, invocationArgs, options);
  return new DaemonSystemService({
    invocation: { ...invocation, cwd: options.cwd ?? process.cwd() },
    platform,
    homeDir: options.homeDir,
    logsDir: options.logsDir,
    uid: options.uid,
    runCommand: options.runCommand,
  });
}

export function createCliDaemonAutoStartController(
  entry: string,
  serveArgs: string[] = [
    "serve",
    "--register",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
  ],
  options: CreateDaemonSystemServiceOptions = {},
): DaemonAutoStartController {
  const service = createDaemonSystemService(entry, serveArgs, options);
  return createDaemonAutoStartController({
    invocation: service.invocation(),
    createService: () => createDaemonSystemService(entry, serveArgs, options),
  });
}
