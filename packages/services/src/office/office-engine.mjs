import { spawn } from "node:child_process";
import { readFile, access, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OFFICE_VERSION = "1.0.139";
export const OFFICE_ASSETS = {
  "win32-x64": [
    "officecli-win-x64.exe",
    "864e0580c8e8c91a6aa4a4c1e8900551c8d4aa648ff10136ceed3a6ba5310888",
  ],
  "win32-arm64": [
    "officecli-win-arm64.exe",
    "6d80a93ba0c9cafb2b52048efbb403cd761b35126130fa8166383599aa91d96e",
  ],
  "linux-x64": [
    "officecli-linux-x64",
    "da07d4f787d7c85724104294ac023c89971ddfaee93ebb183b289282b8f869cc",
  ],
  "linux-arm64": [
    "officecli-linux-arm64",
    "39008c7f76d202858637810553ef14e2cd3e7f61485fdcf2011f26967a7babd1",
  ],
  "darwin-x64": [
    "officecli-mac-x64",
    "6a931d424975dded6ae413c8c1f63d00dfb30a4bd4bd50352964782d13299f5c",
  ],
  "darwin-arm64": [
    "officecli-mac-arm64",
    "393874f79db58222bdbede7f4f942f2536580386923857d1b5ad9754efe80c19",
  ],
};
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verified = new Map();

export async function officeBinaryPath() {
  const asset = OFFICE_ASSETS[`${process.platform}-${process.arch}`]?.[0];
  if (!asset) throw new Error("当前平台不支持内置 Office 引擎。");
  const roots = [
    process.resourcesPath && join(process.resourcesPath, "office-engine"),
    // Electron development argv points at the app directory, not the bundled main script.
    fileURLToPath(new URL("../office-engine/", import.meta.url)),
    join(dirname(process.execPath), "resources/office-engine"),
    resolve(dirname(process.execPath), "../Resources/office-engine"),
    process.argv[1] && resolve(dirname(process.argv[1]), "../office-engine"),
    fileURLToPath(new URL("../../resources/officecli/", import.meta.url)),
  ].filter(Boolean);
  const candidates = [
    process.env.VYKOR_OFFICECLI_PATH,
    ...roots.map((root) => join(root, asset)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("内置 Office 引擎缺失，请运行构建准备脚本或重新安装应用。");
}

export async function createOfficeRunner(context) {
  const expected = OFFICE_ASSETS[`${process.platform}-${process.arch}`]?.[1];
  const binary = context.binaryPath || (await officeBinaryPath());
  if (!expected) throw new Error("当前平台不支持内置 Office 引擎。");
  if (!verified.has(binary)) {
    if (hash(await readFile(binary)) !== expected)
      throw new Error("OfficeCLI 校验失败，请重新安装。");
    // ZIP installation may lose executable permissions. Repair only the verified binary.
    if (process.platform !== "win32") {
      try { await access(binary, constants.X_OK); }
      catch { await chmod(binary, 0o755); }
    }
    verified.set(binary, true);
  }
  return createRunner(binary, context);
}

export function createRunner(binary, context) {
  return async (args, operations, closing = false) => {
    const commandLimit = Number.isFinite(context.commandTimeoutMs)
      ? Math.max(1000, Math.min(60000, context.commandTimeoutMs))
      : 20000;
    const timeout = closing
      ? Math.min(4000, context.deadline - Date.now() - 500)
      : Math.min(commandLimit, context.deadline - Date.now() - 14000);
    if (timeout <= 0 || (!closing && context.signal.aborted))
      throw new Error("Office 操作已取消或超时。");
    return new Promise((resolveResult, reject) => {
      const child = spawn(binary, args, {
        cwd: context.cwd,
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
        env: { ...process.env, OFFICECLI_SKIP_UPDATE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "",
        size = 0,
        failure;
      let killing = false;
      const kill = () => {
        if (killing) return;
        killing = true;
        if (process.platform === "win32" && child.pid) {
          const killer = spawn(
            join(
              process.env.SystemRoot || "C:\\Windows",
              "System32/taskkill.exe",
            ),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          const fallback = setTimeout(() => child.kill(), 1500);
          const finish = () => {
            clearTimeout(fallback);
            child.kill();
          };
          killer.once("error", finish);
          killer.once("close", finish);
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill();
          }
        }
      };
      const abort = () => {
        failure = new Error("Office 操作已取消。");
        kill();
      };
      const timer = setTimeout(() => {
        failure = Object.assign(
          new Error(
            closing ? "Office 工作副本关闭超时。" : "Office 操作超时。",
          ),
          { code: closing ? "office_close_timeout" : "office_command_timeout" },
        );
        kill();
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", abort);
      };
      if (!closing) {
        context.signal.addEventListener("abort", abort, { once: true });
        if (context.signal.aborted) abort();
      }
      const collect = (chunk, error) => {
        size += Buffer.byteLength(chunk);
        if (size > (context.maxOutputBytes || 512000)) {
          failure = new Error(
            "Office 引擎输出超过读取上限，本次未返回完整内容；请拆分文档后重试。",
          );
          kill();
          return;
        }
        if (error) stderr += chunk;
        else stdout += chunk;
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c) => collect(c, false));
      child.stderr.on("data", (c) => collect(c, true));
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.stdin.on("error", (error) => {
        failure = error;
        kill();
      });
      child.on("close", (code) => {
        cleanup();
        if (failure || code !== 0)
          reject(
            failure ||
              new Error(
                (stderr || stdout || `OfficeCLI exit ${code}`).slice(0, 4000),
              ),
          );
        else resolveResult(stdout);
      });
      child.stdin.end(
        operations
          ? JSON.stringify(operations).replace(
              /[\u007f-\uffff]/g,
              (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
            )
          : undefined,
      );
    });
  };
}
