import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { shell } from "electron"

import type { WorkspaceOpener } from "../../../shared/workspace-types"
import { readIconDataUrl } from "./opener-icon"
import { resolveSpawnInvocation } from "./resolve-spawn-invocation"
import { resolveWorkspaceOpenTarget } from "./workspace-path"
import { workspaceService } from "./workspace-service"

const execFileAsync = promisify(execFile)

type OpenerKind = WorkspaceOpener["kind"]

type LaunchPlan =
  | { type: "shell-open" }
  | { type: "spawn"; command: string; args: string[] }
  | { type: "open-app"; appPath: string }

type ResolvedOpener = {
  id: string
  label: string
  kind: OpenerKind
  iconPath: string | null
  launch: LaunchPlan
}

class OpenerService {
  private cache: WorkspaceOpener[] | null = null
  private resolved: ResolvedOpener[] = []

  async listOpeners(): Promise<WorkspaceOpener[]> {
    if (this.cache) return this.cache

    this.resolved = await detectOpeners()
    this.cache = await Promise.all(
      this.resolved.map(async (opener) => ({
        id: opener.id,
        label: opener.label,
        kind: opener.kind,
        iconDataUrl: await readIconDataUrl(opener.iconPath),
      }))
    )
    return this.cache
  }

  async openWith(openerId: string, path: string, rootPath?: string): Promise<void> {
    if (!this.resolved.length) await this.listOpeners()
    const opener = this.resolved.find((item) => item.id === openerId)
    if (!opener) throw new Error("未找到该打开方式。")

    const target = await resolveWorkspaceOpenTarget(
      path,
      rootPath,
      workspaceService.allowedRootsFor(rootPath ?? "")
    )
    await launchOpener(opener, target, rootPath)
  }
}

async function detectOpeners(): Promise<ResolvedOpener[]> {
  if (process.platform === "win32") return detectWindowsOpeners()
  if (process.platform === "darwin") return detectMacOpeners()
  return detectLinuxOpeners()
}

async function detectWindowsOpeners(): Promise<ResolvedOpener[]> {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files"
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
  const windows = process.env.SystemRoot ?? "C:\\Windows"

  const vscode = firstExisting([
    join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"),
    join(programFiles, "Microsoft VS Code", "Code.exe"),
    join(programFilesX86, "Microsoft VS Code", "Code.exe"),
    await whichWindows("Code.exe"),
  ])
  const cursor = firstExisting([
    join(localAppData, "Programs", "cursor", "Cursor.exe"),
    join(localAppData, "Programs", "Cursor", "Cursor.exe"),
    await whichWindows("Cursor.exe"),
  ])
  const visualStudio = findVisualStudio(programFiles, programFilesX86)
  const antigravity = firstExisting([
    join(localAppData, "Programs", "Antigravity", "Antigravity.exe"),
    join(localAppData, "Programs", "antigravity", "Antigravity.exe"),
    await whichWindows("Antigravity.exe"),
  ])
  const githubDesktop = firstExisting([
    join(localAppData, "GitHubDesktop", "GitHubDesktop.exe"),
    join(localAppData, "Programs", "GitHubDesktop", "GitHubDesktop.exe"),
    await whichWindows("GitHubDesktop.exe"),
  ])
  const explorer = join(windows, "explorer.exe")
  const windowsTerminal = firstExisting([
    join(localAppData, "Microsoft", "WindowsApps", "wt.exe"),
    await whichWindows("wt.exe"),
  ])
  const powershell = firstExisting([
    join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    await whichWindows("powershell.exe"),
  ])
  const gitBash = firstExisting([
    join(programFiles, "Git", "git-bash.exe"),
    join(programFilesX86, "Git", "git-bash.exe"),
    join(programFiles, "Git", "bin", "bash.exe"),
  ])
  const wsl = firstExisting([join(windows, "System32", "wsl.exe"), await whichWindows("wsl.exe")])

  const openers: ResolvedOpener[] = []
  pushApp(openers, "vscode", "VS Code", "editor", vscode, (path) => spawnPlan(path, [placeholder]))
  pushApp(openers, "visual-studio", "Visual Studio", "editor", visualStudio, (path) =>
    spawnPlan(path, [placeholder])
  )
  pushApp(openers, "cursor", "Cursor", "editor", cursor, (path) => spawnPlan(path, [placeholder]))
  pushApp(openers, "antigravity", "Antigravity", "editor", antigravity, (path) =>
    spawnPlan(path, [placeholder])
  )
  pushApp(openers, "github-desktop", "GitHub Desktop", "editor", githubDesktop, (path) =>
    spawnPlan(path, [placeholder])
  )
  openers.push({
    id: "explorer",
    label: "文件资源管理器",
    kind: "folder",
    iconPath: existsSync(explorer) ? explorer : null,
    launch: { type: "shell-open" },
  })
  if (windowsTerminal) {
    pushApp(openers, "terminal", "终端", "terminal", windowsTerminal, (path) =>
      spawnPlan(path, ["-d", placeholder])
    )
  } else {
    pushApp(openers, "terminal", "PowerShell", "terminal", powershell, (path) =>
      spawnPlan(path, ["-NoExit", "-NoLogo"])
    )
  }
  pushApp(openers, "git-bash", "Git Bash", "terminal", gitBash, (path) =>
    spawnPlan(path, [`--cd=${placeholder}`])
  )
  pushApp(openers, "wsl", "WSL", "terminal", wsl, (path) => spawnPlan(path, ["--cd", placeholder]))
  return openers
}

async function detectMacOpeners(): Promise<ResolvedOpener[]> {
  const vscode = firstExisting([
    "/Applications/Visual Studio Code.app",
    join(homedir(), "Applications", "Visual Studio Code.app"),
  ])
  const cursor = firstExisting([
    "/Applications/Cursor.app",
    join(homedir(), "Applications", "Cursor.app"),
  ])
  const antigravity = firstExisting([
    "/Applications/Antigravity.app",
    join(homedir(), "Applications", "Antigravity.app"),
  ])
  const githubDesktop = firstExisting([
    "/Applications/GitHub Desktop.app",
    join(homedir(), "Applications", "GitHub Desktop.app"),
  ])
  const xcode = firstExisting(["/Applications/Xcode.app"])
  const finder = firstExisting(["/System/Library/CoreServices/Finder.app"])
  const terminal = firstExisting(["/System/Applications/Utilities/Terminal.app"])
  const iterm = firstExisting(["/Applications/iTerm.app"])

  const openers: ResolvedOpener[] = []
  pushApp(openers, "vscode", "VS Code", "editor", vscode, (path) => openAppPlan(path))
  pushApp(openers, "cursor", "Cursor", "editor", cursor, (path) => openAppPlan(path))
  pushApp(openers, "xcode", "Xcode", "editor", xcode, (path) => openAppPlan(path))
  pushApp(openers, "antigravity", "Antigravity", "editor", antigravity, (path) => openAppPlan(path))
  pushApp(openers, "github-desktop", "GitHub Desktop", "editor", githubDesktop, (path) =>
    openAppPlan(path)
  )
  openers.push({
    id: "finder",
    label: "Finder",
    kind: "folder",
    iconPath: finder,
    launch: { type: "shell-open" },
  })
  pushApp(openers, "terminal", "终端", "terminal", iterm ?? terminal, (path) =>
    path ? openAppPlan(path) : { type: "shell-open" }
  )
  return openers
}

async function detectLinuxOpeners(): Promise<ResolvedOpener[]> {
  const vscode = (await whichUnix("code")) ?? (await whichUnix("code-oss"))
  const cursor = await whichUnix("cursor")
  const antigravity = await whichUnix("antigravity")
  const githubDesktop = (await whichUnix("github-desktop")) ?? (await whichUnix("github-desktop-bin"))
  const gnomeTerminal = await whichUnix("gnome-terminal")
  const konsole = await whichUnix("konsole")
  const xfceTerminal = await whichUnix("xfce4-terminal")
  const kitty = await whichUnix("kitty")
  const xterm = await whichUnix("x-terminal-emulator")
  const terminal =
    gnomeTerminal ?? konsole ?? xfceTerminal ?? kitty ?? xterm ?? (await whichUnix("xterm"))

  const openers: ResolvedOpener[] = []
  pushApp(openers, "vscode", "VS Code", "editor", vscode, (path) => spawnPlan(path, [placeholder]))
  pushApp(openers, "cursor", "Cursor", "editor", cursor, (path) => spawnPlan(path, [placeholder]))
  pushApp(openers, "antigravity", "Antigravity", "editor", antigravity, (path) =>
    spawnPlan(path, [placeholder])
  )
  pushApp(openers, "github-desktop", "GitHub Desktop", "editor", githubDesktop, (path) =>
    spawnPlan(path, [placeholder])
  )
  openers.push({
    id: "files",
    label: "文件管理器",
    kind: "folder",
    iconPath: (await whichUnix("nautilus")) ?? (await whichUnix("dolphin")) ?? null,
    launch: { type: "shell-open" },
  })
  if (terminal) {
    const args = linuxTerminalArgs(terminal)
    pushApp(openers, "terminal", "终端", "terminal", terminal, (path) => spawnPlan(path, args))
  }
  return openers
}

const placeholder = "__FOLDER__"

function spawnPlan(command: string, args: string[]): LaunchPlan {
  return { type: "spawn", command, args }
}

function openAppPlan(appPath: string): LaunchPlan {
  return { type: "open-app", appPath }
}

function pushApp(
  openers: ResolvedOpener[],
  id: string,
  label: string,
  kind: OpenerKind,
  path: string | null,
  launch: (path: string) => LaunchPlan
): void {
  if (!path) return
  openers.push({
    id,
    label,
    kind,
    iconPath: path,
    launch: launch(path),
  })
}

function linuxTerminalArgs(command: string): string[] {
  const name = command.split("/").pop() ?? command
  if (name.includes("gnome-terminal")) return ["--working-directory", placeholder]
  if (name.includes("konsole")) return ["--workdir", placeholder]
  if (name.includes("xfce4-terminal")) return [`--working-directory=${placeholder}`]
  if (name.includes("kitty")) return ["--directory", placeholder]
  return []
}

function findVisualStudio(programFiles: string, programFilesX86: string): string | null {
  const editions = ["Community", "Professional", "Enterprise", "BuildTools"]
  const years = ["2022", "2019"]
  const roots = [programFiles, programFilesX86]
  for (const root of roots) {
    for (const year of years) {
      for (const edition of editions) {
        const candidate = join(
          root,
          "Microsoft Visual Studio",
          year,
          edition,
          "Common7",
          "IDE",
          "devenv.exe"
        )
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

function firstExisting(paths: Array<string | null>): string | null {
  for (const path of paths) {
    if (path && existsSync(path)) return path
  }
  return null
}

async function whichWindows(command: string): Promise<string | null> {
  return whichCommand("where", [command])
}

async function whichUnix(command: string): Promise<string | null> {
  return whichCommand("which", [command])
}

async function whichCommand(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: 2500,
      windowsHide: true,
    })
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => {
        if (!line) return false
        const lower = line.toLowerCase()
        return !lower.endsWith(".cmd") && !lower.endsWith(".bat")
      })
    if (first && existsSync(first)) return first
    const any = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return any && existsSync(any) ? any : null
  } catch {
    return null
  }
}

async function launchOpener(
  opener: ResolvedOpener,
  target: { path: string; isDirectory: boolean },
  rootPath?: string
): Promise<void> {
  const folderPath = target.isDirectory ? target.path : dirname(target.path)
  const launchPath = resolveLaunchPath(opener, target, folderPath, rootPath)
  const plan = opener.launch

  if (plan.type === "shell-open") {
    if (target.isDirectory) {
      const error = await shell.openPath(target.path)
      if (error) throw new Error(error)
      return
    }
    shell.showItemInFolder(target.path)
    return
  }

  if (plan.type === "open-app") {
    await spawnDetached("open", ["-a", plan.appPath, launchPath], folderPath)
    return
  }

  const args = plan.args.map((arg) => arg.replaceAll(placeholder, launchPath))
  const invocation = resolveSpawnInvocation({
    platform: process.platform,
    kind: opener.kind,
    command: plan.command,
    args,
    cwd: folderPath,
  })
  await spawnDetached(invocation.command, invocation.args, folderPath, opener.kind === "terminal")
}

function resolveLaunchPath(
  opener: ResolvedOpener,
  target: { path: string; isDirectory: boolean },
  folderPath: string,
  rootPath?: string
): string {
  if (opener.kind === "terminal") return folderPath
  if (opener.id === "github-desktop") {
    return rootPath?.trim() ? resolve(rootPath) : folderPath
  }
  return target.path
}

function spawnDetached(
  command: string,
  args: string[],
  cwd?: string,
  hideWindowsConsole = false
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: hideWindowsConsole,
    })
    child.once("error", reject)
    child.unref()
    queueMicrotask(() => resolvePromise())
  })
}

export const openerService = new OpenerService()
