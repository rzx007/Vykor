/** 识别直接启动，或先切目录再启动的常见服务；不猜测任意脚本。 */
export function isPersistentServiceCommand(command: string): boolean {
  let text = command.trim().toLowerCase();
  // 这里只用于识别，启动时仍传递原命令，保留路径、引号和输出规则。
  const changeDirectory = /^(?:cd(?:\s+\/d)?|set-location(?:\s+-(?:path|literalpath))?)\s+(?:"[^"]*"|'[^']*'|[^\s;&|'"<>]+)\s*(?:;|&&|\r?\n)\s*/;
  while (changeDirectory.test(text)) text = text.replace(changeDirectory, "");
  text = text.replace(/\s+2>&1\s*$/, "");
  if (/[;&|\r\n]/.test(text)) return false;
  if (/(?:^|\s)(?:--help|--version|-h)(?:\s|$)/.test(text)) return false;
  if (/^docker(?:\s+compose|-compose)\s+up\b/.test(text)) {
    return !/(?:^|\s)(?:-d|--detach)(?:\s|$)/.test(text);
  }
  return [
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch)(?:\s|$)/,
    /^(?:(?:npx|bunx|pnpm\s+exec)\s+)?(?:vite|next|nuxt|astro|webpack|rollup|parcel|tsc)\b.*(?:\b(?:dev|start|serve|watch)\b|(?:^|\s)(?:-w|--watch)(?:\s|$))/,
    /^(?:(?:npx|bunx|pnpm\s+exec)\s+)?vite(?:\s+(?!(?:build|optimize)(?:\s|$))|$)/,
    /^(?:python[\d.]*|py)(?:\s+-\d(?:\.\d+)?)?\s+-m\s+http\.server\b/,
    /^(?:(?:python[\d.]*|py)\s+-m\s+)?(?:uvicorn|gunicorn)\b/,
    /^flask\s+(?:--app\s+\S+\s+)?run\b/,
  ].some(pattern => pattern.test(text));
}
