/** A read deadline covers headers and body parsing, even when a fetcher ignores cancellation. */
export class ReadDeadlineError extends Error {
  override readonly name = "ReadDeadlineError";
}
export async function withReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ReadDeadlineError("The document catalog read timed out. It can be retried."));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([read(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
