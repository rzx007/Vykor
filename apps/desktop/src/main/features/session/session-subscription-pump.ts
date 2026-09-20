export interface SubscriptionPumpOptions<T> {
  initialIterator?: AsyncIterator<T>
  createIterator(): AsyncIterator<T> | Promise<AsyncIterator<T>>
  isActive(): boolean
  onUpdate(value: T): void
  onReconnecting?(last: T): void
  onError?(error: unknown): void
  backoffMs?(attempt: number): number
  sleep?(ms: number): Promise<void>
}

const DEFAULT_BACKOFF_MS = (attempt: number): number =>
  Math.min(30_000, 250 * 2 ** Math.max(0, attempt))

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 消费订阅迭代器；迭代器结束或抛错后按退避重建并继续，直到 isActive() 为假。
 * 订阅替换、窗口销毁、controller abort 都由调用方的 isActive() 表达。
 */
export async function pumpSubscription<T>(options: SubscriptionPumpOptions<T>): Promise<void> {
  let attempt = 0
  let iterator = options.initialIterator
  let last: T | undefined

  while (options.isActive()) {
    try {
      iterator ??= await options.createIterator()
      while (options.isActive()) {
        const update = await iterator.next()
        if (update.done) break
        if (!options.isActive()) break
        last = update.value
        options.onUpdate(update.value)
      }
      iterator = undefined
    } catch (error) {
      iterator = undefined
      options.onError?.(error)
    }
    if (!options.isActive()) return
    if (last !== undefined) options.onReconnecting?.(last)
    await (options.sleep ?? defaultSleep)((options.backoffMs ?? DEFAULT_BACKOFF_MS)(attempt))
    attempt += 1
  }
}
