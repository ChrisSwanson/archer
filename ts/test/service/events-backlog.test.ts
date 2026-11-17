// An event stream whose reader stops reading is closed once its unsent bytes pass a bound, instead of the
// service buffering every later event for it (a suspended laptop, a paused tab, a stalled network).
import { createServer, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { expect, test } from "vitest";
import { boundedWrite, MAX_EVENT_STREAM_BACKLOG_BYTES } from "../../src/service/http.ts";

test("the bound is a few MiB: room for bursts, not for an unbounded backlog", () => {
  expect(MAX_EVENT_STREAM_BACKLOG_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
  expect(MAX_EVENT_STREAM_BACKLOG_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
});

test("a reader that stops reading is cut off once the stream holds more than the bound; one that reads is not", async () => {
  const limit = 256 * 1024,
    event = `event: x\ndata: ${"y".repeat(16 * 1024)}\n\n`;
  const results: { overflowed: boolean; written: number; peak: number }[] = [];
  const server = createServer((_req, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let overflowed = false,
      written = 0,
      peak = 0;
    const tick = setInterval(() => {
      for (let i = 0; i < 8 && !overflowed; i++) {
        if (
          boundedWrite(
            res,
            event,
            () => {
              overflowed = true;
              res.destroy();
            },
            limit,
          )
        )
          written++;
        peak = Math.max(peak, res.writableLength);
      }
      if (overflowed || written >= 400) {
        clearInterval(tick);
        results.push({ overflowed, written, peak });
        if (!overflowed) res.end();
      }
    }, 5);
    res.on("close", () => clearInterval(tick));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const request = `GET / HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n`;
  try {
    // Stalled: reads nothing, so the kernel buffers fill and the rest stays in the service.
    const stalled = connect(port, "127.0.0.1");
    stalled.pause();
    stalled.write(request);
    await expect.poll(() => results.length, { timeout: 10_000 }).toBe(1);
    expect(results[0]!.overflowed).toBe(true);
    // Held what it may plus one event that was already queued, never more.
    expect(results[0]!.peak).toBeLessThanOrEqual(limit + 8 * event.length);
    stalled.destroy();
    // Reading: drains as it goes and receives every event.
    const reading = connect(port, "127.0.0.1");
    let received = 0;
    reading.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    reading.write(request);
    await expect.poll(() => results.length, { timeout: 15_000 }).toBe(2);
    expect(results[1]!).toMatchObject({ overflowed: false, written: 400 });
    await expect.poll(() => received, { timeout: 5_000 }).toBeGreaterThanOrEqual(400 * event.length);
    reading.destroy();
  } finally {
    server.close();
  }
});
