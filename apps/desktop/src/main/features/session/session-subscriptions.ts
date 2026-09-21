export interface SessionSubscription {
  controller: AbortController
  sessionId: string
}

export class SessionSubscriptionRegistry {
  private readonly owners = new Map<number, Map<string, SessionSubscription>>()

  set(ownerId: number, slot: string, subscription: SessionSubscription): void {
    const subscriptions = this.owners.get(ownerId) ?? new Map<string, SessionSubscription>()
    subscriptions.get(slot)?.controller.abort()
    subscriptions.set(slot, subscription)
    this.owners.set(ownerId, subscriptions)
  }

  get(ownerId: number, slot: string): SessionSubscription | undefined {
    return this.owners.get(ownerId)?.get(slot)
  }

  isCurrent(ownerId: number, slot: string, subscription: SessionSubscription): boolean {
    return this.get(ownerId, slot) === subscription
  }

  deleteIfCurrent(ownerId: number, slot: string, subscription: SessionSubscription): boolean {
    if (!this.isCurrent(ownerId, slot, subscription)) return false
    return this.delete(ownerId, slot)
  }

  delete(ownerId: number, slot: string): boolean {
    const subscriptions = this.owners.get(ownerId)
    const subscription = subscriptions?.get(slot)
    if (!subscriptions || !subscription) return false
    subscription.controller.abort()
    subscriptions.delete(slot)
    if (subscriptions.size === 0) this.owners.delete(ownerId)
    return true
  }

  deleteMatchingSessions(ownerId: number, sessionIds: ReadonlySet<string>): void {
    const subscriptions = this.owners.get(ownerId)
    if (!subscriptions) return
    for (const [slot, subscription] of subscriptions) {
      if (sessionIds.has(subscription.sessionId)) this.delete(ownerId, slot)
    }
  }

  clearOwner(ownerId: number): void {
    const subscriptions = this.owners.get(ownerId)
    if (!subscriptions) return
    for (const subscription of subscriptions.values()) subscription.controller.abort()
    this.owners.delete(ownerId)
  }

  clearAll(): void {
    for (const ownerId of this.owners.keys()) this.clearOwner(ownerId)
  }
}

export async function reserveSubscriptionSnapshot<T>(
  registry: SessionSubscriptionRegistry,
  ownerId: number,
  slot: string,
  subscription: SessionSubscription,
  createIterator: () => AsyncIterator<T> | Promise<AsyncIterator<T>>,
  emptyMessage: string
): Promise<{ snapshot: T; iterator: AsyncIterator<T> }> {
  registry.set(ownerId, slot, subscription)
  try {
    const iterator = await createIterator()
    if (!registry.isCurrent(ownerId, slot, subscription)) {
      throw new Error("订阅已被替换或关闭。")
    }
    const first = await iterator.next()
    if (!registry.isCurrent(ownerId, slot, subscription)) {
      throw new Error("订阅已被替换或关闭。")
    }
    if (first.done) throw new Error(emptyMessage)
    return { snapshot: first.value, iterator }
  } catch (error) {
    registry.deleteIfCurrent(ownerId, slot, subscription)
    throw error
  }
}
