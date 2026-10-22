const immutableMapViews = new WeakSet<object>();

/** Expose set membership without allowing callers to widen the captured scope. */
export function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const inner = new Set(values);
  // Object.freeze(Set) still permits add/delete/clear; shadow them so only reads remain.
  Object.assign(inner, { add: undefined, delete: undefined, clear: undefined });
  return Object.freeze(inner);
}


/** Object.freeze(Map) still permits set/delete; expose only read operations. */
export function readonlyMap<T>(entries: Iterable<readonly [string, T]>): ReadonlyMap<string, T> {
  if (typeof entries === "object" && entries !== null && immutableMapViews.has(entries)) return entries as ReadonlyMap<string,T>;
  const inner = new Map(entries);
  const view: ReadonlyMap<string, T> = Object.freeze({
    size: inner.size,
    get: (key: string) => inner.get(key),
    has: (key: string) => inner.has(key),
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    forEach: (callback: (value: T, key: string, map: ReadonlyMap<string, T>) => void, thisArg?: unknown) =>
      inner.forEach((value, key) => callback.call(thisArg, value, key, view)),
  });
  immutableMapViews.add(view);
  return view;
}
