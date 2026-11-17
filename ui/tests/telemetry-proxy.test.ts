// The dev server forwards only the page's telemetry upload to the service, with the browser's own
// cookie, so a client of the dev server never reaches a debug route as the dev server's loopback peer.
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { debugProxyBypass } from "../vite.config";

it("forwards POST /-/debug/events and nothing else under /-/debug/", () => {
  const table = [
    ["POST", "/-/debug/events"],
    ["POST", "/-/debug/events?x=1"],
    ["GET", "/-/debug/events"],
    ["GET", "/-/debug/health"],
    ["GET", "/-/debug/metrics"],
    ["GET", "/-/debug/log"],
    ["POST", "/-/debug/reset"],
    ["POST", "/-/debug/profile/cpu?seconds=1"],
    ["POST", "/-/debug/heap-snapshot"],
    ["POST", "/-/debug/events/../reset"],
  ] as const;
  expect(table.map(([method, url]) => [method, url, debugProxyBypass(method, url) === undefined])).toEqual(
    table.map(([method, url], i) => [method, url, i < 2]),
  );
});

let service: Server,
  vite: ViteDevServer,
  base = "";
const seen: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];

beforeAll(async () => {
  service = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  process.env.ARCHER_DEV_SERVER = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  vite = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1", hmr: false, watch: null },
  });
  await vite.listen();
  base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await vite?.close();
  await new Promise<void>((resolve) => service?.close(() => resolve()));
  delete process.env.ARCHER_DEV_SERVER;
});

it("through the running dev server: the upload reaches the service with the browser's cookie; the rest stops at 404", async () => {
  const cookie = `archer-1=${"c".repeat(64)}`;
  const upload = await fetch(`${base}/-/debug/events`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  expect(upload.status).toBe(200);
  expect(seen.map((r) => [r.method, r.url, r.headers.cookie])).toEqual([["POST", "/-/debug/events", cookie]]);
  for (const [method, path] of [
    ["GET", "health"],
    ["GET", "metrics"],
    ["GET", "log"],
    ["GET", "events"],
    ["POST", "reset"],
    ["POST", "profile/cpu?seconds=1"],
    ["POST", "heap-snapshot"],
  ]) {
    const reply = await fetch(`${base}/-/debug/${path}`, { method, headers: { cookie } });
    expect([path, reply.status]).toEqual([path, 404]);
  }
  expect(seen).toHaveLength(1);
}, 60_000);
