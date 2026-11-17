// warmStart (production's default): Mermaid's parsers load before the HTTP port opens, so the first
// compile on the request path does not hold the event loop; background drawing starts promptly.
import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/index.ts";
import { cleanUp, project, service, write } from "./support.ts";

afterEach(cleanUp);

test("a warm start loads the compilers before it listens; a cold one does not", async () => {
  const warm: string[] = [],
    cold: string[] = [];
  await service({ warmStart: true, prefetchThumbnails: false, log: (line) => warm.push(line) });
  await service({ warmStart: false, log: (line) => cold.push(line) });
  expect(warm.some((line) => /compilers loaded in \d+ ms/.test(line))).toBe(true);
  expect(cold.some((line) => /compilers loaded/.test(line))).toBe(false);
});

test("a warm start draws a new project's thumbnails without any request", async () => {
  const { svc, state } = await service({ warmStart: true });
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    write(root, ".archer/one.mmd", "flowchart LR\n  a[A]\n  b[B]\n  a e1@--> b\n");
    await client.call("attach", { root });
    const cache = join(state, "cache", "thumbnails");
    const drawn = (): number =>
      existsSync(cache) ? readdirSync(cache).filter((name) => name.endsWith(".thumb")).length : 0;
    const deadline = Date.now() + 20_000;
    // The fixture project's views (flow, chat, one) in light and dark.
    while (drawn() < 6 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drawn()).toBeGreaterThanOrEqual(6);
  } finally {
    client.close();
  }
}, 40_000);
