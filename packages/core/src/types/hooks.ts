import type { HookEvent, HookResult } from "@vykor/agent-contracts";
import type { HookDefinition } from "@vykor/host-config";
export interface HookExecutor {
  register(hook: HookDefinition): void;
  /** 可选:列出已注册 hooks(hooks 包实现提供;/reload-plugins 清理插件 hooks 用)。 */
  getAll?(): readonly HookDefinition[];
  /** 可选:按 id 注销。 */
  unregister?(hookId: string): void;
  execute(
    event: HookEvent,
    context: Record<string, unknown>
  ): Promise<HookResult>;
}
