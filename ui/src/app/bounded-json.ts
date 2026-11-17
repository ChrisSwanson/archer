/** Shared across one snapshot's concurrent reads; bytes are charged before decoding/parsing. */
export type JsonReadBudget = { remaining: number };
export const JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const JSON_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
export class JsonReadRefusal extends Error {
  override readonly name = "JsonReadRefusal";
}

/** A finite byte stream is required. A caller also owns the clock deadline for a stalled body. */
export async function readBoundedJson(
  response: Response,
  budget: JsonReadBudget,
  signal?: AbortSignal,
): Promise<unknown> {
  if (budget.remaining <= 0) throw new JsonReadRefusal("The JSON byte budget was exhausted.");
  if (!response.body) throw new JsonReadRefusal("The response has no JSON body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new JsonReadRefusal("The read was cancelled.");
      const part = await reader.read();
      if (signal?.aborted) throw new JsonReadRefusal("The read was cancelled.");
      if (part.done) break;
      bytes += part.value.byteLength;
      budget.remaining -= part.value.byteLength;
      if (bytes > JSON_RESPONSE_MAX_BYTES || budget.remaining < 0)
        throw new JsonReadRefusal("The JSON byte budget was exceeded.");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    cancel();
    if (error instanceof JsonReadRefusal) throw error;
    throw new JsonReadRefusal("The response is not readable JSON.");
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
