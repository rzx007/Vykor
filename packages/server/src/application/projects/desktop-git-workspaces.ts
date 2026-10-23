import {
  createChildAgentWorktreeManager,
  type GitRunner,
} from "@vykor/agent-runtime";

/** Reuse the safe child-worktree manager and retain the desktop's exact, already-selected branch name. */
export async function createDesktopGitWorktree(input: {
  cwd: string;
  configDir: string;
  slug: string;
  branch: string;
  runGit: GitRunner;
}) {
  const manager = createChildAgentWorktreeManager({
    cwd: input.cwd,
    configDir: input.configDir,
    runGit: (args, cwd) =>
      input.runGit(
        args[0] === "worktree" && args[1] === "add"
          ? ["worktree", "add", "-b", input.branch, ...args.slice(4)]
          : args,
        cwd,
      ),
  });
  if (!(await manager.isGitRepo()))
    throw new Error("项目不是 Git 仓库，不能创建独立工作目录。");
  const result = await manager.create(input.slug);
  if (!result.created) throw new Error("独立工作目录已存在，请重新创建任务。");
  return { ...result, branch: input.branch };
}
