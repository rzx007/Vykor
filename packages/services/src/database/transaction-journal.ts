export class TransactionJournal {
  private values = new WeakMap<object, Map<string | symbol, unknown>>();
  private mapKeys = new WeakMap<object, Set<unknown>>();
  private eventOwners = new WeakSet<object>();
  private restorations: Array<() => void> = [];

  capture<T extends object, K extends keyof T>(target: T, key: K): void {
    const property = typeof key === "symbol" ? key : String(key);
    let values = this.values.get(target);
    if (values?.has(property)) return;

    const existed = Object.hasOwn(target, key);
    const value = existed ? structuredClone(target[key]) : undefined;
    if (!values) {
      values = new Map();
      this.values.set(target, values);
    }
    values.set(property, value);
    this.restorations.push(() => {
      if (existed) target[key] = value as T[K];
      else delete target[key];
    });
  }

  captureMap<K, V>(target: Map<K, V>, key: K): void {
    let keys = this.mapKeys.get(target);
    if (keys?.has(key)) return;

    const existed = target.has(key);
    const value = existed ? structuredClone(target.get(key)) : undefined;
    if (!keys) {
      keys = new Set();
      this.mapKeys.set(target, keys);
    }
    keys.add(key);
    this.restorations.push(() => {
      if (existed) target.set(key, value as V);
      else target.delete(key);
    });
  }

  // Events are immutable once retained; only append and array replacement need undoing.
  captureEvents<T>(owner: { events: T[] }): void {
    if (this.eventOwners.has(owner)) return;
    const events = owner.events;
    const length = events.length;
    this.eventOwners.add(owner);
    this.restorations.push(() => {
      owner.events = events;
      events.length = length;
    });
  }

  previous<T extends object, K extends keyof T>(target: T, key: K): T[K] | undefined {
    const property = typeof key === "symbol" ? key : String(key);
    return this.values.get(target)?.get(property) as T[K] | undefined;
  }

  rollback(): void {
    const errors: unknown[] = [];
    for (let index = this.restorations.length - 1; index >= 0; index -= 1) {
      try {
        this.restorations[index]!();
      } catch (error) {
        errors.push(error);
      }
    }
    this.clear();
    if (errors.length) {
      throw new AggregateError(errors, "Transaction rollback failed");
    }
  }

  clear(): void {
    this.values = new WeakMap();
    this.mapKeys = new WeakMap();
    this.eventOwners = new WeakSet();
    this.restorations = [];
  }
}
