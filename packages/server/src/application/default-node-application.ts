import { SessionStore } from "@vykor/services";

import { getDefaultSessionStorePath } from "../daemon/paths.js";
import {
  DaemonApplication,
  type DaemonApplicationOptions,
} from "./daemon-application.js";

export interface DefaultNodeApplicationOptions
  extends Omit<DaemonApplicationOptions, "store" | "ownsStore"> {
  store?: SessionStore;
  storePath?: string;
  /** 外部传入 Store 时默认由外部关闭；需要 Application 关闭它时明确设为 true。 */
  ownsStore?: boolean;
}

/**
 * 默认 Node 进程的组装入口。CLI、Desktop 或 HTTP 可以直接用它拿到同一个应用。
 * 这里创建的 Store 会随 Application.close() 一起关闭。
 */
export function createDefaultNodeApplication(
  options: DefaultNodeApplicationOptions,
): DaemonApplication {
  const store =
    options.store ??
    new SessionStore({
      path: options.storePath ?? getDefaultSessionStorePath(),
      attachmentLimits: options.attachmentLimits,
    });
  return new DaemonApplication({
    ...options,
    store,
    ownsStore: options.ownsStore ?? !options.store,
  });
}
