/** Shared ownership only: scheduling and shutdown policy stay with each concrete pool. */
export function sharedPool<Pool extends { close(): void }, Options>(
  create: (options: Options) => Pool,
  dispose: (pool: Pool) => void = (pool) => pool.close(),
): (options: Options) => { pool: Pool; stop(): void; release(): void } {
  let shared: { pool: Pool; users: number } | undefined;
  return (options) => {
    const current = (shared ??= { pool: create(options), users: 0 });
    current.users++;
    let released = false;
    return {
      pool: current.pool,
      stop: () => {
        if (!released && current.users === 1) current.pool.close();
      },
      release: () => {
        if (released) return;
        released = true;
        if (--current.users === 0 && shared === current) {
          shared = undefined;
          dispose(current.pool);
        }
      },
    };
  };
}
