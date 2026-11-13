import { Command } from "commander";
import { dirname, join } from "node:path";
import { dataRootHome, isWithinManagedPath, readDataRootSelector, requireCompleteAbsolutePath, resolveUserDataPaths, withDataRootRecoveryLock } from "@vykor/host-config/paths";
import { DaemonSystemService, inspectDataRootMigration, migrateDataRootAndRestart, recoverDataRootMigration, type DataRootMigrationRequest } from "@vykor/server/daemon-host";
import { resolveDaemonInvocation } from "../daemon-process.js";

/** Local maintenance deliberately runs before initializeDataRoot and writer admission. */
export function createDataRootCommand(entry: string): Command {
  const command = new Command("data-root").description("本机用户数据整根检查、迁移与恢复（不调用模型）");
  const homeDir = dataRootHome();
  const request = (options: { from: string; to: string }): DataRootMigrationRequest => ({
    homeDir, sourceRoot: requireCompleteAbsolutePath(options.from, "--from"), targetRoot: requireCompleteAbsolutePath(options.to, "--to"),
    environment: { ...process.env }, rootInputs: { homeDir, environment: Object.fromEntries(
      ["VYKOR_CONFIG_DIR", "VYKOR_DATA_DIR", "VYKOR_CHANNELS_DIR", "VYKOR_IMAGE_ATTACHMENT_CACHE_DIR"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])) },
    desktopExportPath: resolveUserDataPaths(options.from).legacyImportFilePath,
  });
  const invocation = (args: string[]) => ({ ...resolveDaemonInvocation(entry, args), cwd: dirname(entry) });
  const service = (root: string, logsDir: string) => new DaemonSystemService({ homeDir, logsDir, invocation: invocation(["--data-root", root,
    ...(process.platform === "win32" ? ["daemon", "watchdog"] : []), "serve", "--register", ...(process.platform === "win32" ? [] : ["--supervised"])]) });
  for (const operation of ["inspect", "migrate"] as const) command.command(operation)
    .requiredOption("--from <完整旧根>", "完整用户数据旧根")
    .requiredOption("--to <完整目标根>", "完整用户数据目标根")
    .action(async (options: { from: string; to: string }) => {
      const input = request(options), preview = await inspectDataRootMigration(input);
      if (operation === "inspect") {
        console.log(JSON.stringify({ source: { path: preview.sourceRoot, origin: "--from" }, target: { path: preview.targetRoot, origin: "--to" }, preview }, null, 2));
        return;
      }
      if (preview.blockers.length) {
        console.log(JSON.stringify({ phase: "preflight", usableRoot: input.sourceRoot, preview }, null, 2));
        throw new Error("迁移预检未通过。needs_desktop_export 请使用 Desktop 本机数据根维护入口完成业务导出。源数据保持原位。");
      }
      const runtime = preview.sources.filter(source => source.origin === "runtime-data" && preview.databases.some(database => isWithinManagedPath(database.path, source.from))).sort((a, b) => b.from.length - a.from.length)[0];
      const result = await migrateDataRootAndRestart(input, { systemService: service(input.sourceRoot, runtime ? join(runtime.from, "logs") : resolveUserDataPaths(input.sourceRoot).logsDir),
        validation: invocation(["--internal-data-root-validation"]), target: invocation(["--data-root", input.targetRoot, "serve", "--register"]) });
      console.log(JSON.stringify({ ...result, usableRoot: result.writersReleased ? input.targetRoot : input.sourceRoot }, null, 2));
      if (result.startup !== "ready") process.exitCode = 1;
    });
  command.command("recover").description("恢复已记录迁移，或仅恢复已死亡的普通启动锁")
    .option("--journal <完整迁移记录路径>", "迁移记录的完整路径")
    .option("--startup-lock", "无迁移记录时，仅核对并恢复死亡启动锁")
    .action(async (options: { journal?: string; startupLock?: boolean }) => {
      if (!!options.journal === !!options.startupLock) throw new Error("使用 vk data-root recover --journal <完整迁移记录路径> 或 vk data-root recover --startup-lock。");
      if (options.startupLock) {
        await withDataRootRecoveryLock(homeDir, async () => {
          const pending = readDataRootSelector(homeDir)?.pendingMigration;
          if (pending) throw new Error(`已有迁移记录；请运行 vk data-root recover --journal "${pending.journalPath}"。`);
        }, { timeoutMs: 500 });
        console.log(JSON.stringify({ recovered: "startup-lock" })); return;
      }
      const journal = requireCompleteAbsolutePath(options.journal!, "--journal");
      console.log(JSON.stringify(await recoverDataRootMigration(journal, { homeDir }), null, 2));
    });
  return command;
}

export async function runDataRootCommand(argv: string[], entry: string): Promise<void> {
  await createDataRootCommand(entry).parseAsync(argv, { from: "user" });
}
