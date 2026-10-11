/** 只识别直接启动的常见服务；不猜测脚本、引号内文本或复合命令。 */
export function isPersistentServiceCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
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
