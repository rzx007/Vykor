/**
 * TUI 前端入口（进程 B，Bun 运行时）。配置经 VYKOR_FRONTEND_CONFIG 注入；
 * daemon 主线由 useServerSync attach。
 * 详见 docs/tui-flow.md 与 docs/client-sync-flow.md。
 */
import { getTheme } from "./theme/builtinThemes";
import { assertSupportedTuiRuntime } from "./runtime";
import type { FrontendConfig } from "./types";

const rawConfig = process.env.VYKOR_FRONTEND_CONFIG;
let config: FrontendConfig;
try {
  const parsed = rawConfig ? JSON.parse(rawConfig) : {};
  config = {
    daemon: parsed.daemon ?? (
      process.env.VYKOR_DAEMON_URL
        ? {
            url: process.env.VYKOR_DAEMON_URL,
            token: process.env.VYKOR_DAEMON_TOKEN ?? null,
            cwd: process.env.VYKOR_DAEMON_CWD ?? null,
            model: process.env.VYKOR_DAEMON_MODEL ?? null,
          }
        : null
    ),
    initial_prompt: parsed.initial_prompt ?? process.env.VYKOR_INITIAL_PROMPT ?? null,
    theme: parsed.theme ?? process.env.VYKOR_THEME ?? "default",
    version: parsed.version ?? null,
  };
} catch {
  config = { daemon: null, theme: "default" };
}

try {
  // OpenTUI 默认 backgroundColor 为 transparent，会透出终端配色；启动时铺上主题底色。
  // Run before importing OpenTUI because its native DLL can crash an unsupported Bun.
  assertSupportedTuiRuntime();
  const [{ createCliRenderer }, { createElement, createRoot }, { App }] = await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("./App"),
  ]);
  const initialBg = getTheme(String(config.theme ?? "default")).colors.background;
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    backgroundColor: initialBg,
    onDestroy: () => process.exit(process.exitCode ?? 0),
  });
  renderer.setTerminalTitle("Vykor");
  createRoot(renderer).render(createElement(App, { config }));
} catch (err) {
  console.error("[vykor] 终端渲染器初始化失败（需要 Bun + 支持的平台）：", err);
  process.exit(1);
}
