/**
 * A store the service opens on first use and keeps (service.ts: authoring grants, change review, the authoring
 * journal, presentations). A failure to open is kept too: every later `get` throws the same error, and the store
 * is not opened again. `assertOpen` (the service's stopping check) runs first at every `get`, before the kept
 * failure or store. `wrap` maps a raw failure to the store's own refusal; without it the raw failure is kept.
 */
export interface LazyStore<T> {
  /** The store, opened now if it was not; throws the stopping refusal or the kept failure. */
  get(): T;
  /** The store if it is open; never opens it, never refuses. */
  peek(): T | undefined;
}

export function lazyStore<T>(
  open: () => T,
  o: { readonly assertOpen?: () => void; readonly wrap?: (failure: unknown) => unknown },
): LazyStore<T> {
  let store: T | undefined;
  let failed = false;
  let failure: unknown;
  return {
    get(): T {
      o.assertOpen?.();
      if (failed) throw failure;
      if (store !== undefined) return store;
      try {
        store = open();
        return store;
      } catch (raw) {
        failure = o.wrap === undefined ? raw : o.wrap(raw);
        failed = true;
        throw failure;
      }
    },
    peek: () => store,
  };
}
