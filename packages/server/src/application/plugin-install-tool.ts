import type { ToolDefinition, ToolResult } from "@vykor/core";
import type { PluginService } from "./settings-api.js";

const reply = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/** The daemon owns installation; the model only selects a source. */
export function createPluginInstallTool(
  plugins: PluginService,
  invalidateRuntimes: () => Promise<void>,
): ToolDefinition {
  return {
    name: "PluginInstall",
    description: "Install an existing Vykor Native Plugin from a local .zip/.tar/.tar.gz/.tgz file or a Git URL. Preview the exact identity and permissions and ask the user before installing. New plugins become available in the next conversation.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["archive", "git"] },
        path: { type: "string", description: "Absolute local plugin archive path, for source=archive" },
        url: { type: "string", description: "Git URL, for source=git" },
        ref: { type: "string", description: "Optional Git branch, tag, or commit" },
      },
      required: ["source"],
    },
    async execute(input, context) {
      if (!context.askUserPrompt) return reply("对话安装需要可用的用户确认入口。", true);
      const source = input.source;
      if (source !== "archive" && source !== "git") return reply("source 必须是 archive 或 git。", true);
      if (source === "archive" && (typeof input.path !== "string" || !input.path.trim())) {
        return reply("请提供本地插件包路径。", true);
      }
      if (source === "git" && (typeof input.url !== "string" || !input.url.trim())) {
        return reply("请提供 Git URL。", true);
      }
      if (input.ref !== undefined && typeof input.ref !== "string") return reply("ref 必须是字符串。", true);
      try {
        if (source === "archive" && (!plugins.previewArchive || !plugins.installArchive)) return reply("当前服务不支持插件包安装。", true);
        if (source === "git" && (!plugins.previewGit || !plugins.installGit)) return reply("当前服务不支持 Git 插件安装。", true);
        const candidate = source === "archive"
          ? await plugins.previewArchive!({ cwd: context.cwd, archivePath: input.path as string })
          : await plugins.previewGit!({ cwd: context.cwd, url: input.url as string, ...(input.ref ? { ref: input.ref as string } : {}) });
        const origin = source === "archive" ? input.path as string : `${input.url}@${"commit" in candidate ? candidate.commit : ""}`;
        const question = [
          `确认安装插件 ${candidate.identity.displayName ?? candidate.identity.name} (${candidate.identity.id}, v${candidate.identity.version})？`,
          `来源：${origin}`,
          `申请权限：${candidate.requestedPermissions.length ? candidate.requestedPermissions.join("、") : "无"}`,
          "回复“确认安装”才会继续。",
        ].join("\n");
        const answer = (await context.askUserPrompt(question)).trim();
        if (answer !== "确认安装") return reply("已取消插件安装。");
        const approvedPermissions = candidate.approvalRequired ? candidate.requestedPermissions : [];
        const result = source === "archive" && "archiveDigest" in candidate
          ? await plugins.installArchive!({
              cwd: context.cwd,
              archivePath: input.path as string,
              expectedArchiveDigest: candidate.archiveDigest,
              approvedPermissions,
            })
          : "sourceDigest" in candidate ? await plugins.installGit!({
              cwd: context.cwd,
              url: input.url as string,
              ...(input.ref ? { ref: input.ref as string } : {}),
              expectedSourceDigest: candidate.sourceDigest,
              approvedPermissions,
            }) : undefined;
        if (!result) return reply("插件来源与预览结果不一致。", true);
        try {
          await invalidateRuntimes();
          return reply(`${result.message} 下一次对话生效。`);
        } catch (error) {
          return reply(`${result.message} 运行时刷新失败，请使用 /reload-plugins 后再使用新插件：${error instanceof Error ? error.message : String(error)}`);
        }
      } catch (error) {
        return reply(error instanceof Error ? error.message : String(error), true);
      }
    },
  };
}
