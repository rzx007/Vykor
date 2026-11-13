import { readFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { VykorClient } from "@rzx/client";
import { Service } from "../../../packages/client/src/service/index.js";
import { readDataRootSelector, resolveManagedHistoryPath } from "@vykor/host-config/paths";
import { cliInvocation, publishRoot, rootFixture, scriptedRootServer } from "../../helpers/data-root-fixture.js";

afterEach(() => vi.unstubAllEnvs());

it("discovers the published root across two migrations and continues formal history without restoring temporary content", async () => {
  const fixture = await rootFixture();
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME"])
    vi.stubEnv(key, fixture.environment[key]);
  vi.stubEnv("VYKOR_CONFIG_DIR", fixture.sourceRoot);
  vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1");
  const old = await scriptedRootServer(fixture.sourceRoot);
  let sourceClosed = false, completed = false, endpoint: Awaited<ReturnType<typeof Service.ensure>> | undefined;
  const secret = "temporary-body-must-never-recover-acceptance";
  try {
    const cwd = join(fixture.sourceRoot, "workspaces/chat");
    await fixture.file(join(cwd, "linked.txt"), "historical resource");
    const metadata = { desktop: { workspaceMode: "outside_project" } };
    const formal = await old.client.sessions.create({ cwd, model: "root-fixture", metadata });
    const temporary = await old.client.sessions.create({ cwd, model: "root-fixture", storage: "memory", metadata });
    expect((await old.prompt(formal.id, `formal history ${cwd}`)).status).toBe("completed");
    expect((await old.prompt(temporary.id, secret)).status).toBe("completed");
    await old.client.sessions.createGoal(temporary.id, { requestId: "owned-temporary-goal", objective: secret, maxAutoTurns: 1 });
    await old.close(); sourceClosed = true;
    await fixture.diagnose("source-closed");
    await fixture.file(join(fixture.sourceRoot, "credentials.json"), '{"providers":{"test":{"apiKey":"owned-private-key"}}}');
    await fixture.file(join(fixture.sourceRoot, "teams/opaque.json"), '{"keep":true}');
    await fixture.file(join(fixture.sourceRoot, ".skills_store_lock.json"), "opaque lock");
    const consolidationLock = join(fixture.sourceRoot, "data/memory/.consolidate-lock"), consolidatedAt = 1_500_000_000;
    await fixture.file(consolidationLock, "opaque consolidation marker");
    await utimes(consolidationLock, consolidatedAt, consolidatedAt);
    const original = await readFile(join(fixture.sourceRoot, "data/session-runtime/sessions.db"));
    expect(original.includes(Buffer.from(secret))).toBe(false);

    const first = await publishRoot(fixture.request());
    await fixture.diagnose("first-published");
    expect(first, await readFile(first.journalPath, "utf8")).toMatchObject({ phase: "committed", writersReleased: true });
    expect((await stat(join(fixture.targetRoot, "data/memory/.consolidate-lock"))).mtimeMs).toBe(consolidatedAt * 1000);
    expect(await readFile(join(fixture.sourceRoot, "data/session-runtime/sessions.db"))).toEqual(original);
    expect((await stat(join(fixture.sourceRoot, "credentials.json"))).ino).not.toBe((await stat(join(fixture.targetRoot, "credentials.json"))).ino);
    const environment = fixture.environment;
    const launch = cliInvocation(["serve", "--register"], fixture.preload);
    const diagnostics = join(fixture.directory, "owned-cli-stderr.log");
    try { endpoint = await Service.ensure({ env: environment, command: [launch.command, ...launch.args], timeoutMs: 45000 }); }
    catch (error) { throw new Error(`${String(error)}; owned CLI diagnostics: ${(await readFile(diagnostics, "utf8").catch(() => "no stderr")).slice(-8000)}`, { cause: error }); }
    expect((await Service.discover({ env: environment }))?.pid).toBe(endpoint.pid);
    await fixture.diagnose("sdk-ready", { childPid: endpoint.pid });
    const connected = new VykorClient(Service.clientOptions(endpoint));
    expect((await connected.sessions.getState(formal.id)).parts.map(part => part.text).join("\n")).toContain(`formal history ${cwd}`);
    await expect(connected.sessions.getState(temporary.id)).rejects.toMatchObject({ status: 404 });
    const stoppedPid = endpoint.pid;
    expect(await Service.stop(endpoint, { timeoutMs: 15000 })).toBe(true); endpoint = undefined;
    let alive = true; try { process.kill(stoppedPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    await fixture.diagnose("sdk-stopped", { childPid: stoppedPid, alive });

    const resumed = await fixture.continueFormal(fixture.targetRoot, formal.id);
    expect(resumed).toMatchObject({ root: fixture.targetRoot, sessionId: formal.id, status: "completed", historyPreserved: true, continued: true });
    expect(resumed.pid).not.toBe(process.pid);
    expect(() => process.kill(resumed.pid, 0)).toThrow();
    await fixture.diagnose("continuation-child-closed", { childPid: resumed.pid });
    const finalRoot = join(fixture.directory, "再次迁移");
    expect(await publishRoot(fixture.request(fixture.targetRoot, finalRoot))).toMatchObject({ phase: "committed", writersReleased: true });
    expect(readDataRootSelector(fixture.homeDir)).toEqual({ version: 1, dataRoot: finalRoot });
    const historical = await resolveManagedHistoryPath(join(cwd, "linked.txt"), finalRoot);
    expect(historical).toBe(join(finalRoot, "workspaces/chat/linked.txt"));
    expect(await readFile(historical, "utf8")).toBe("historical resource");
    for (const result of [first]) {
      const journal = await readFile(result.journalPath, "utf8");
      expect(journal).not.toContain(secret); expect(journal).not.toContain("owned-private-key");
    }
    expect((await readFile(join(finalRoot, "data/session-runtime/sessions.db"))).includes(Buffer.from(secret))).toBe(false);
    expect(await readFile(join(finalRoot, ".skills_store_lock.json"), "utf8")).toBe("opaque lock");
    completed = true;
  } catch (error) {
    await fixture.diagnose("test-failed", { code: (error as { code?: string }).code, message: String(error) }); throw error;
  } finally {
    if (endpoint) await Service.stop(endpoint, { timeoutMs: 15000 }).catch(() => {});
    if (!sourceClosed) await old.close();
    await fixture.close({ preserve: !completed && process.env.VYKOR_TEST_KEEP_ROOT === "1" });
  }
}, 150000);
