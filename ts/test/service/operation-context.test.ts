import { revisionOf } from "../../src/project/index.ts";
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/client.ts";
import { parseRequest } from "../../src/service/socket.ts";
import { BROKEN, FLOW2, cleanUp, json, project, service, tempDir, write, apiBase } from "./support.ts";
afterEach(cleanUp);
test("a fresh front door reads another client's presentation and last-good model after broken source", async () => {
  const root = project();
  const { svc } = await service();
  const first = await connectService(svc.socketPath);
  const fresh = await connectService(svc.socketPath);
  try {
    await first.call("attach", { root });
    const shown = await first.call("present", { root, viewId: "flow", annotation: "Shared caption" });
    const context = await fresh.call("getContext", { root });
    expect(context.presentation).toMatchObject({
      presentationId: shown.presentationId,
      viewId: "flow",
      annotation: "Shared caption",
    });
    expect(context.selection).toBeNull();
    const good = await fresh.call("getModel", { root, viewId: "flow" });
    expect(good.envelope?.view.id).toBe("flow");
    expect(good.envelope?.revision).toBe(context.presentation?.revision);
    write(root, ".archer/flow.mmd", BROKEN);
    expect(await fresh.call("getModel", { root, viewId: "flow" })).toEqual(good);
    await expect(fresh.call("getModel", { root, viewId: "missing" })).rejects.toMatchObject({
      error: { code: "diagram_not_found" },
    });
  } finally {
    first.close();
    fresh.close();
  }
});
test.each([
  { method: "getContext", params: { root: "/project", extra: true } },
  { method: "getModel", params: { root: "/project", viewId: "bad id" } },
  { method: "getModel", params: { root: "/project", viewId: "flow", extra: true } },
])("snapshot validates complete request: $method $params", ({ method, params }) => {
  expect(() => parseRequest({ id: 1, method, params })).toThrow();
});

test("bundled programmatic API starts Archer's entry rather than its host application", async () => {
  const root = tempDir();
  const chunks = join(root, "chunks");
  mkdirSync(chunks);
  const entry = join(root, "archer.js");
  writeFileSync(entry, "// shipped CLI entry\n");
  const client = join(chunks, "client.mjs");
  await build({
    entryPoints: [new URL("../../src/service/client.ts", import.meta.url).pathname],
    outfile: client,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  const bundled = await import(pathToFileURL(client).href);
  expect(bundled.defaultServeCommand()).toEqual([process.execPath, entry, "serve", "--foreground"]);
});

test("present refreshes the live model before acknowledging a changed source", async () => {
  const root = project();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const { url } = await client.call("attach", { root });
    write(root, ".archer/flow.mmd", FLOW2);
    const shown = await client.call("present", { root, viewId: "flow" });
    const bootstrap = (await json(`${apiBase(url)}api/bootstrap`)) as {
      envelope: { revision: string };
      presentation: { presentationId: string; revision: string };
    };
    expect(bootstrap.presentation.presentationId).toBe(shown.presentationId);
    expect(bootstrap.presentation.revision).toBe(revisionOf(Buffer.from(FLOW2)));
    expect(bootstrap.envelope.revision).toBe(revisionOf(Buffer.from(FLOW2)));
  } finally {
    client.close();
  }
});
