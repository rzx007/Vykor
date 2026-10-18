// 供应商和认证入口共用保存队列，避免并发校验后覆盖彼此的配置。
// 排队的只是配置保存，不要求正在运行的任务停止。
const pendingUpdates = new WeakMap<object, Promise<void>>();

export async function withProviderConfigurationUpdate<T>(
  owner: object,
  update: () => Promise<T>,
): Promise<T> {
  const previous = pendingUpdates.get(owner) ?? Promise.resolve();
  const result = previous.then(update);
  const settled = result.then(() => undefined, () => undefined);
  pendingUpdates.set(owner, settled);
  try {
    return await result;
  } finally {
    if (pendingUpdates.get(owner) === settled) pendingUpdates.delete(owner);
  }
}
