export type ShellFamily = "powershell" | "cmd" | "posix";

export type ShellDialect =
  | "windows-powershell"
  | "pwsh"
  | "cmd"
  | "bash"
  | "posix-sh"
  | "zsh";

export interface ShellDescriptor {
  family: ShellFamily;
  dialect: ShellDialect;
  executable: string;
  argsPrefix: string[];
  displayName: string;
  version?: string;
  pathStyle: "windows" | "posix";
  tempDir: string;
  capabilities: {
    conditionalAndOr: boolean;
    supportsLoginShell: boolean;
  };
}

export interface ShellResultMetadata extends Record<string, unknown> {
  shellFamily: ShellDescriptor["family"];
  shellDialect: ShellDescriptor["dialect"];
  shellExecutable: string;
  shellDisplayName: string;
  pathStyle: ShellDescriptor["pathStyle"];
  exitCode: number | null;
  status: "completed" | "failed" | "timed_out" | "interrupted";
}

export function shellArgv(shell: ShellDescriptor, command: string): string[] {
  const script = shell.dialect === "windows-powershell"
    ? `$utf8 = New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; $PSDefaultParameterValues['*:Encoding'] = 'utf8'; ${command}`
    : command;
  const startupArgs = shell.dialect === "pwsh"
    ? shell.argsPrefix.filter(arg => !/^(?:-interactive|-i)$/i.test(arg))
    : shell.argsPrefix;
  const args = shell.family === "powershell" && !startupArgs.some(arg => /^-noni(?:nteractive)?$/i.test(arg))
    ? ["-NonInteractive", ...startupArgs]
    : startupArgs;
  return [shell.executable, ...args, script];
}

export function shellResultMetadata(
  shell: ShellDescriptor,
  exitCode: number | null,
  status: ShellResultMetadata["status"],
): ShellResultMetadata {
  return {
    shellFamily: shell.family,
    shellDialect: shell.dialect,
    shellExecutable: shell.executable,
    shellDisplayName: shell.displayName,
    pathStyle: shell.pathStyle,
    exitCode,
    status,
  };
}
