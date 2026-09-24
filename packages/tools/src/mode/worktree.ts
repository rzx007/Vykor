import { PROJECT_CONFIG_DIR_NAME, type ToolDefinition } from "@vykor/core";

export const enterWorktreeTool: ToolDefinition = {
  name: "EnterWorktree",
  description: "Create a git worktree and return its path.",
  inputSchema: {
    type: "object",
    properties: {
      branch: { type: "string", description: "Target branch name" },
      path: { type: "string", description: "Optional worktree path" },
      createBranch: { type: "boolean", description: "Create new branch", default: true },
      baseRef: { type: "string", description: "Base ref when creating branch", default: "HEAD" },
    },
    required: ["branch"],
  },
  async execute(input, context) {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { resolve, join } = await import("node:path");
    const execAsync = promisify(exec);

    const branch = input.branch as string;
    const createBranch = (input.createBranch as boolean) ?? true;
    const baseRef = (input.baseRef as string) ?? "HEAD";

    let topLevel: string;
    try {
      const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd: context.cwd, windowsHide: true });
      topLevel = stdout.trim();
    } catch {
      return { content: [{ type: "text", text: "enter_worktree requires a git repository" }], isError: true };
    }

    const slug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "worktree";
    const worktreePath = input.path
      ? resolve(context.cwd, input.path as string)
      : resolve(topLevel, PROJECT_CONFIG_DIR_NAME, "worktrees", slug);

    const cmd = createBranch
      ? `git worktree add -b "${branch}" "${worktreePath}" ${baseRef}`
      : `git worktree add "${worktreePath}" "${branch}"`;

    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: topLevel, windowsHide: true });
      const output = (stdout || stderr).trim() || `Created worktree ${worktreePath}`;
      return { content: [{ type: "text", text: `${output}\nPath: ${worktreePath}` }] };
    } catch (err: any) {
      const msg = err.stderr || err.message;
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  },
};

export const exitWorktreeTool: ToolDefinition = {
  name: "ExitWorktree",
  description: "Remove a git worktree by path.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Worktree path to remove" } },
    required: ["path"],
  },
  async execute(input, context) {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { resolve } = await import("node:path");
    const execAsync = promisify(exec);

    let path = input.path as string;
    if (!resolve(path).startsWith("/")) path = resolve(context.cwd, path);

    try {
      const { stdout, stderr } = await execAsync(`git worktree remove --force "${path}"`, { cwd: context.cwd, windowsHide: true });
      const output = (stdout || stderr).trim() || `Removed worktree ${path}`;
      return { content: [{ type: "text", text: output }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: err.stderr || err.message }], isError: true };
    }
  },
};
