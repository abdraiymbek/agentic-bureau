/**
 * Structural sharing for data that is fetched again and again. A refresh returns new objects
 * even when nothing changed; these helpers hand back the previous objects wherever the new data
 * is equal, so a memoised view or an effect keyed on an object only runs when that object
 * really changed.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * `next`, with every subtree that equals the matching subtree of `prev` replaced by `prev`'s.
 * Returns `prev` itself when the two are structurally equal. Arrays are compared by position;
 * use `shareList` for lists whose items have an identity.
 */
export function shareDeep<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  const arrays = Array.isArray(prev) && Array.isArray(next);
  if (!arrays && !(isPlainObject(prev) && isPlainObject(next))) return next;
  const before = prev as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = arrays ? (next as unknown[]).map((_, i) => String(i)) : Object.keys(after);
  const previousSize = arrays ? (prev as unknown[]).length : Object.keys(before).length;
  const copy: Record<string, unknown> | unknown[] = arrays ? [] : {};
  let same = 0;
  for (const key of keys) {
    const value = shareDeep(before[key], after[key]);
    (copy as Record<string, unknown>)[key] = value;
    if (Object.prototype.hasOwnProperty.call(before, key) && Object.is(value, before[key])) same++;
  }
  return (previousSize === keys.length && same === keys.length ? prev : copy) as T;
}

/**
 * `next`, keeping the previous item for every key whose item is unchanged, wherever it moved.
 * Returns `prev` itself when the list has the same items in the same order.
 */
export function shareList<T>(
  prev: readonly T[],
  next: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const item of prev) byKey.set(keyOf(item), item);
  let unchanged = prev.length === next.length;
  const out = next.map((item, i) => {
    const shared = shareDeep(byKey.get(keyOf(item)), item);
    if (shared !== prev[i]) unchanged = false;
    return shared;
  });
  return unchanged ? (prev as T[]) : out;
}
