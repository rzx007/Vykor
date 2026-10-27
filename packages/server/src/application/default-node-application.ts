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
 * 返回前工厂负责自建 Store；成功返回后按 ownsStore 决定是否随应用关闭。
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
  const ownsStore = options.ownsStore ?? !options.store;
  try {
    return new DaemonApplication({ ...options, store, ownsStore });
  } catch (constructionError) {
    // 尚未返回的自建 Store 没有接手者，即使成功后不归应用关闭也要回收。
    if (!options.store || ownsStore) {
      try {
        store.close();
      } catch (closeError) {
        throw new AggregateError(
          [constructionError, closeError],
          "Daemon application construction and Store cleanup failed",
        );
      }
    }
    throw constructionError;
  }
}
