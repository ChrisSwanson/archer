// Slice 4 (ADR 0034 §6): the service carries the walkthrough an agent presents, the page's
// inventory carries each diagram's walkthrough count, and get_presentation_context reports the
// walkthrough and step the person is reading.
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { apiBase, cleanUp, events, http, json, service, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

const FLOW = "flowchart LR\n  a[Client]\n  b[API]\n  c[(Store)]\n  a e1@-->|Calls| b\n  b e2@-->|Writes| c\n";
const draft = {
  id: "ask",
  title: "Asking",
  steps: [
    { title: "Ask", kind: "sends", what: "A request.", edges: [{ id: "e1" }] },
    { title: "Store", kind: "sends", what: "A write.", edges: [{ id: "e2" }] },
  ],
};

async function setup() {
  const cwd = tempDir();
  write(cwd, ".archer/flow.mmd", FLOW);
  const { svc } = await service();
  const app = createApplication({
    cwd,
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  });
  const read = await app.call("read_diagram", { viewId: "flow" });
  await app.call("write_walkthrough", {
    viewId: "flow",
    modelRevision: read.structured["modelRevision"],
    walkthrough: draft,
  });
  return { cwd, app };
}

const post = (base: string, origin: string, path: string, body: unknown) =>
  http(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });

test("a presented walkthrough rides the presentation event and the context, and a plain present drops it", async () => {
  const { app } = await setup();
  try {
    const shown = await app.call("present_diagram", {
      viewId: "flow",
      walkthrough: { id: "ask", step: 2 },
      annotation: "The write.",
    });
    const url = new URL((shown.structured["ui"] as { url: string }).url);
    // The stable link (claude-08): the diagram's own address, at the step presented.
    expect(url.pathname).toMatch(/^\/projects\/[a-z0-9-]+\/flow\.mmd$/);
    expect(url.search).toMatch(/^\?token=[0-9a-f]+&walkthrough=ask&step=2$/);
    expect((shown.structured["ui"] as { followUrl: string }).followUrl).toMatch(
      /\/\?follow&token=[0-9a-f]+&walkthrough=ask&step=2$/,
    );
    const base = apiBase(url.toString());
    const boot = (await json(`${base}api/bootstrap`)) as { presentation: Record<string, unknown> };
    expect(boot.presentation).toMatchObject({
      viewId: "flow",
      annotation: "The write.",
      walkthrough: { id: "ask", step: 2 },
    });
    const context = await app.call("get_presentation_context", {});
    expect(context.structured["presentation"]).toMatchObject({ walkthrough: { id: "ask", step: 2 } });
    await app.call("present_diagram", { viewId: "flow" });
    expect(
      (await app.call("get_presentation_context", {})).structured["presentation"] as Record<string, unknown>,
    ).not.toHaveProperty("walkthrough");
  } finally {
    app.close();
  }
});

test("the page's inventory carries the walkthrough count, and says so again when one is written", async () => {
  const { app } = await setup();
  try {
    const shown = await app.call("present_diagram", { viewId: "flow", walkthrough: { id: "ask" } });
    const base = apiBase((shown.structured["ui"] as { url: string }).url);
    const listed = (await json(`${base}api/diagrams`)) as { views: { id: string; walkthroughs?: number }[] };
    expect(listed.views.find((v) => v.id === "flow")?.walkthroughs).toBe(1);
    const stream = await events(`${base}api/events`);
    const read = await app.call("read_diagram", { viewId: "flow" });
    await app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: read.structured["modelRevision"],
      walkthrough: { ...draft, id: "second", title: "Second" },
    });
    const inventory = (await stream.next("inventory")) as { views: { id: string; walkthroughs?: number }[] };
    expect(inventory.views.find((v) => v.id === "flow")?.walkthroughs).toBe(2);
    stream.close();
  } finally {
    app.close();
  }
});

test("get_presentation_context reports the walkthrough and step the person is reading", async () => {
  const { app } = await setup();
  try {
    const shown = await app.call("present_diagram", { viewId: "flow" });
    const url = (shown.structured["ui"] as { url: string }).url;
    const base = apiBase(url);
    const origin = new URL(url).origin;
    expect((await app.call("get_presentation_context", {})).structured["walkthrough"]).toBeFalsy();
    expect((await post(base, origin, "api/walkthrough-position", { viewId: "flow", id: "ask", step: 2 })).status).toBe(
      204,
    );
    const read = await app.call("get_presentation_context", {});
    expect(read.structured["walkthrough"]).toEqual({ viewId: "flow", id: "ask", step: 2 });
    expect(read.text).toContain("walkthrough 'ask' at step 2");
    // Closing the panel clears it; nonsense is refused and changes nothing.
    expect((await post(base, origin, "api/walkthrough-position", { viewId: "flow", id: "ask", step: 0 })).status).toBe(
      422,
    );
    expect((await post(base, origin, "api/walkthrough-position", { viewId: "flow", id: "nope", step: 1 })).status).toBe(
      204,
    );
    expect((await post(base, origin, "api/walkthrough-position", { viewId: "flow", id: null })).status).toBe(204);
    expect((await app.call("get_presentation_context", {})).structured["walkthrough"]).toBeFalsy();
    // A foreign origin is refused: the cookie a browser sends from elsewhere admits no write (the bare 404).
    expect(
      (await post(base, "http://evil.example", "api/walkthrough-position", { viewId: "flow", id: "ask", step: 1 }))
        .status,
    ).toBe(404);
  } finally {
    app.close();
  }
});
