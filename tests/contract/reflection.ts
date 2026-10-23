// Reflection helpers for the "no driver object is reachable" tests.

/** Every object reachable by reflection: own keys (strings and symbols),
 * descriptors (value/get/set — getters are not invoked), prototypes. */
export function reachable(roots: unknown[]): Set<object> {
  const seen = new Set<object>()
  const queue = [...roots]
  while (queue.length) {
    const o = queue.pop()
    if (!o || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o as object)) continue
    seen.add(o as object)
    queue.push(Object.getPrototypeOf(o))
    for (const k of Reflect.ownKeys(o as object)) {
      const d = Reflect.getOwnPropertyDescriptor(o as object, k)
      if (!d) continue
      queue.push(d.value, d.get, d.set)
    }
  }
  return seen
}

/** JavaScript's own objects (AsyncFunction: async methods). */
export const BUILTIN = reachable([
  Function.prototype,
  Object.prototype,
  Array.prototype,
  Promise.prototype,
  Object.getPrototypeOf(async () => {}),
])

/** The objects themselves plus the functions on their own descriptors. */
export function ownSurface(objects: object[]): Set<object> {
  const ours = new Set<object>()
  for (const f of objects) {
    ours.add(f)
    for (const k of Reflect.ownKeys(f)) {
      const d = Reflect.getOwnPropertyDescriptor(f, k)!
      for (const x of [d.value, d.get, d.set]) if (x && typeof x === 'function') ours.add(x)
    }
  }
  return ours
}

/** Reachable objects that are neither JavaScript's nor in `ours`. */
export function foreignReachable(roots: object[], ours: Set<object>): object[] {
  return [...reachable(roots)].filter((o) => !BUILTIN.has(o) && !ours.has(o))
}

export const ENDED = /this test has ended/

export const refused = (fn: () => unknown) =>
  Promise.resolve()
    .then(fn)
    .then(
      () => 'ran',
      (e: unknown) => String(e),
    )
