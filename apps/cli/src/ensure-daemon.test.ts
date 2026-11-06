import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ discover: vi.fn(), ensure: vi.fn() }));
const host = vi.hoisted(() => ({
  readDaemonRegistry: vi.fn(), daemonPidAlive: vi.fn(),
  getDaemonRegistryPath: () => "registry.json",
  withDaemonControlLock: (action: () => unknown) => action(),
}));
const state = vi.hoisted(() => ({
  autoStart: vi.fn(), reconcile: vi.fn(), restart: vi.fn(), probe: vi.fn(),
}));
vi.mock("@vykor/application-client/service", () => ({ Service: sdk }));
vi.mock("@vykor/server/daemon-host", () => host);
vi.mock("./daemon-auto-start.js", () => ({ loadDaemonAutoStart: state.autoStart, reconcileDaemonAutoStart: state.reconcile }));
vi.mock("./daemon-lifecycle.js", () => ({ probeDaemonRegistry: state.probe }));
vi.mock("./daemon-process.js", () => ({
  resolveDaemonInvocation: (entry: string, args: string[]) => ({ command: "node", args: [entry, ...args] }),
}));

import { ensureLocalDaemon } from "./ensure-daemon.js";

const endpoint = {
  file: "registry.json", pid: 123, url: "http://127.0.0.1:4321",
  token: "token", storePath: "sessions.db", version: "1.2.0", startedAt: 123,
};
const cliPath = "D:/repo/cli.js";

beforeEach(() => {
  vi.resetAllMocks();
  state.autoStart.mockResolvedValue(false);
  state.reconcile.mockReturnValue({ action: "none", service: { restart: state.restart } });
});

describe("ensureLocalDaemon", () => {
  it("reuses the verified endpoint without starting a separate process", async () => {
    sdk.discover.mockResolvedValue(endpoint);
    await expect(ensureLocalDaemon({ cliPath })).resolves.toMatchObject(endpoint);
    expect(sdk.ensure).not.toHaveBeenCalled();
  });

  it("passes the CLI command to the same startup lock as Desktop", async () => {
    sdk.ensure.mockResolvedValue(endpoint);
    await expect(ensureLocalDaemon({ cliPath })).resolves.toMatchObject(endpoint);
    expect(sdk.ensure).toHaveBeenCalledWith(expect.objectContaining({
      file: "registry.json",
      command: ["node", cliPath, "serve", "--register", "--host", "127.0.0.1", "--port", "0"],
    }));
  });

  it("preserves a live unresponsive legacy registration", async () => {
    host.readDaemonRegistry.mockReturnValue(endpoint);
    host.daemonPidAlive.mockReturnValue(true);
    state.probe.mockResolvedValue("unreachable");
    await expect(ensureLocalDaemon({ cliPath })).rejects.toThrow(/temporarily unavailable/);
    expect(sdk.ensure).not.toHaveBeenCalled();
  });

  it("accepts a live explicitly registered legacy backend", async () => {
    host.readDaemonRegistry.mockReturnValue(endpoint);
    host.daemonPidAlive.mockReturnValue(true);
    state.probe.mockResolvedValue("ready");
    await expect(ensureLocalDaemon({ cliPath })).resolves.toMatchObject(endpoint);
  });

  it("restarts an installed system service and waits for its endpoint", async () => {
    state.autoStart.mockResolvedValue(true);
    sdk.discover.mockResolvedValueOnce(undefined).mockResolvedValueOnce(endpoint);
    await expect(ensureLocalDaemon({ cliPath })).resolves.toMatchObject(endpoint);
    expect(state.restart).toHaveBeenCalledOnce();
    expect(sdk.ensure).not.toHaveBeenCalled();
  });

  it("does not restart a service just installed by reconciliation", async () => {
    state.autoStart.mockResolvedValue(true);
    state.reconcile.mockReturnValue({ action: "installed", service: { restart: state.restart } });
    sdk.discover.mockResolvedValueOnce(undefined).mockResolvedValueOnce(endpoint);
    await expect(ensureLocalDaemon({ cliPath })).resolves.toMatchObject(endpoint);
    expect(state.restart).not.toHaveBeenCalled();
  });
});
