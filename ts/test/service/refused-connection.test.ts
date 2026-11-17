// After a request body is refused unread (413), the connection lingers to drain it (RFC 9112 §9.6). A request
// sent on that connection meanwhile is read and dropped, never dispatched: its answer could not reach the
// client, and a write it asked for would run unseen.
import { connect } from "node:net";
import { expect, test } from "vitest";
import { readBody } from "../../src/service/http.ts";
import { createWebServer } from "../../src/service/web-server.ts";

test("a request pipelined behind a refused body is never dispatched", async () => {
  const dispatched: string[] = [];
  const server = createWebServer(
    { scheme: "http" },
    (req, res) => {
      dispatched.push(`${req.method} ${req.url}`);
      void readBody(req, res, 1024).then((text) => {
        if (text !== null) res.end("ok");
      });
    },
    false,
  );
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  try {
    // Half-open: a client may keep writing after the server ends its side.
    const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
    });
    socket.on("error", () => {});
    // Over the cap, then (after the 413) a second request while the server is still draining.
    socket.write(`POST /big HTTP/1.1\r\nhost: x\r\ncontent-length: 4096\r\n\r\n${"a".repeat(2048)}`);
    await expect.poll(() => received.includes("413"), { timeout: 5_000 }).toBe(true);
    // The rest of the refused body, then requests at once and later in the 2 s drain.
    socket.write("a".repeat(2048));
    for (const [delay, path] of [
      [50, "/after1"],
      [800, "/after2"],
      [1200, "/after3"],
    ] as const) {
      await new Promise((ok) => setTimeout(ok, delay));
      socket.write(`POST ${path} HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\n\r\nhi`);
    }
    await new Promise((ok) => setTimeout(ok, 500));
    expect(dispatched).toEqual(["POST /big"]);
    socket.destroy();
  } finally {
    server.close();
  }
});
