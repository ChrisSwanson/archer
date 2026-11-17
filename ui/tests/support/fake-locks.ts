/**
 * A Web Locks manager for jsdom (which has none), one per test process: what draft-tabs.ts needs. Tests act as
 * another open tab by holding `archer.tab.v1:<id>` (`holdTab`), and as that tab closing by releasing it.
 */
type Grant = { name: string; release: () => void };
export function installFakeLocks(): void {
  if (typeof navigator === "undefined" || (navigator as { locks?: unknown }).locks !== undefined) return;
  const held = new Map<string, number>();
  const waiting: { name: string; run: () => void }[] = [];
  const pump = (): void => {
    for (let i = 0; i < waiting.length; i++)
      if (!held.has(waiting[i]!.name)) {
        const [w] = waiting.splice(i, 1);
        w!.run();
        i = -1;
      }
  };
  const request = (name: string, a: unknown, b?: unknown): Promise<unknown> => {
    const options = (typeof a === "function" ? {} : a) as LockOptions;
    const callback = (typeof a === "function" ? a : b) as (lock: Lock | null) => unknown;
    return new Promise((resolve, reject) => {
      const run = (): void => {
        held.set(name, (held.get(name) ?? 0) + 1);
        Promise.resolve(callback({ name, mode: "exclusive" } as Lock))
          .then(resolve, reject)
          .finally(() => {
            held.delete(name);
            pump();
          });
      };
      if (!held.has(name)) {
        run();
        return;
      }
      if (options.ifAvailable) {
        Promise.resolve(callback(null)).then(resolve, reject);
        return;
      }
      const entry = { name, run };
      waiting.push(entry);
      options.signal?.addEventListener("abort", () => {
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  };
  const query = async (): Promise<LockManagerSnapshot> => ({
    held: [...held.keys()].map((name) => ({ name, mode: "exclusive" as const, clientId: "" })),
    pending: waiting.map((w) => ({ name: w.name, mode: "exclusive" as const, clientId: "" })),
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request, query } });
}

/** Acts as an open tab with owner `id` until the returned function is called (the tab closes; await it to be gone). */
export function holdTab(id: string): () => Promise<void> {
  let release!: () => void;
  const done = navigator.locks.request(
    `archer.tab.v1:${id}`,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  return async () => {
    release();
    await done;
    await new Promise((r) => setTimeout(r, 0));
  };
}
export type { Grant };
