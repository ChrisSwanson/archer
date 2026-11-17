// present_diagram's `expand: [{element, source}]` and get_presentation_context's exploration (ADR 0036 §14,
// A10, A11) through the operation an agent calls: the link that reopens the picture, every refusal in one
// answer with nothing presented, schema bounds, the walkthrough exclusion, and the reader's additions read back.
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { decodeExpansions } from "../../../shared/explorations.mts";
import { apiBase, cleanUp, http, service, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

const SHOP = { element: "shop", source: "containers" },
  API = { element: "api", source: "deploy" };

async function setup(extra: Record<string, string> = {}) {
  const cwd = tempDir();
  for (const [path, text] of Object.entries(extra)) write(cwd, path, text);
  write(
    cwd,
    ".archer/context.mmd",
    'C4Context\nPerson(user, "Shopper")\nSystem(shop, "Shop")\nRel(user, shop, "buys from")\n',
  );
  write(
    cwd,
    ".archer/containers.mmd",
    'C4Container\nPerson(user, "Shopper")\nSystem_Boundary(shop, "Shop") {\n  Container(web, "Web")\n  Container(api, "API")\n}\nRel(user, web, "uses")\nRel(web, api, "calls")\n',
  );
  write(
    cwd,
    ".archer/deploy.mmd",
    "flowchart LR\n  api[API]:::container\n  queue[Jobs]:::container\n  api e1@--> queue\n",
  );
  const { svc } = await service();
  const app = createApplication({
    cwd,
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  });
  return { cwd, app };
}

test("present_diagram with expand presents the exploration; its link carries it; the agent reads it back", async () => {
  const { app } = await setup();
  try {
    const shown = await app.call("present_diagram", { viewId: "context", expand: [SHOP, API], annotation: "Orders" });
    expect(shown.structured["presentation"]).toMatchObject({
      viewId: "context",
      annotation: "Orders",
      exploration: { sources: 2, parts: 3 },
    });
    const url = new URL((shown.structured["ui"] as { url: string }).url);
    expect(decodeExpansions(url.searchParams.get("expand"))).toEqual({ ok: true, expansions: [SHOP, API] });
    expect(shown.text).toContain(url.toString());
    expect(shown.text).toMatch(/3 part\(s\) from 2 other diagram\(s\) added in frames/);
    const context = await app.call("get_presentation_context", {});
    expect(context.structured["exploration"]).toMatchObject({
      origin: "presentation",
      frames: [{ source: "containers" }, { source: "deploy" }],
    });
    expect(context.text).toContain(
      "You presented 'context' with 2 added diagram(s): 'containers' (from shop), 'deploy' (from api).",
    );
    // The person adds nothing more but selects a part of a frame: it is reported as (source, id).
    const followUrl = (shown.structured["ui"] as { followUrl?: string; url: string }).followUrl ?? url.toString();
    const revision = (shown.structured["presentation"] as { revision: string }).revision;
    const posted = await http(`${apiBase(followUrl)}api/reader-exploration`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url.origin },
      body: JSON.stringify({
        viewId: "context",
        revision,
        expand: [SHOP, API],
        selection: [{ source: "deploy", kind: "node", id: "queue" }],
      }),
    });
    expect(posted.status).toBe(204);
    const read = await app.call("get_presentation_context", {});
    expect(read.structured["exploration"]).toMatchObject({
      origin: "reader",
      selection: [{ source: "deploy", id: "queue", label: "Jobs" }],
    });
    expect(read.text).toContain("They selected 1 part(s) in frames: queue in 'deploy'.");
  } finally {
    app.close();
  }
});

// codex-12-01 (O254): an entry naming one neighbour presents that neighbour, and its link replays the same.
test("present_diagram's expand takes a neighbour; the link names it", async () => {
  const { app } = await setup();
  try {
    const QUEUE = { element: "api", source: "deploy", neighbour: "queue" };
    const shown = await app.call("present_diagram", { viewId: "context", expand: [SHOP, QUEUE] });
    expect(shown.structured["presentation"]).toMatchObject({ exploration: { sources: 2, parts: 3 } });
    expect(
      decodeExpansions(new URL((shown.structured["ui"] as { url: string }).url).searchParams.get("expand")),
    ).toEqual({ ok: true, expansions: [SHOP, QUEUE] });
    expect((await app.call("get_presentation_context", {})).structured["exploration"]).toMatchObject({
      expand: [SHOP, QUEUE],
    });
  } finally {
    app.close();
  }
});

// codex-12-03 (O255): a presented exploration no link can carry is presented, with the view's own link and a line saying so.
test("present_diagram with more than a link holds: the exploration is shown, the link is the view's own, and the text says why", async () => {
  const ids = Array.from({ length: 24 }, (_, i) => `neighbour_${String(i).padStart(2, "0")}_`.padEnd(120, "x"));
  const star = `flowchart LR\n  a[A]:::container\n${ids.map((id) => `  ${id}[N]:::container\n`).join("")}${ids.map((id, i) => `  a w${i}@--> ${id}\n`).join("")}`;
  const { app } = await setup({ ".archer/hub.mmd": "flowchart LR\n  a[A]:::container\n", ".archer/star.mmd": star });
  try {
    const expand = ids.map((id) => ({ element: "a", source: "star", neighbour: id }));
    const shown = await app.call("present_diagram", { viewId: "hub", expand });
    expect(shown.structured["presentation"]).toMatchObject({ exploration: { sources: 1, parts: 24 } });
    const ui = shown.structured["ui"] as { url: string; expandLink?: unknown };
    expect(new URL(ui.url).searchParams.has("expand")).toBe(false);
    expect(ui.expandLink).toMatchObject({ shared: false, problem: expect.stringMatching(/4096/) });
    expect(shown.text).toContain(ui.url);
    expect(shown.text).toMatch(/link opens the view without its additions/);
  } finally {
    app.close();
  }
});

test("every bad entry is named in one refusal, and nothing is presented", async () => {
  const { app } = await setup();
  try {
    await app.call("present_diagram", { viewId: "deploy" });
    await expect(
      app.call("present_diagram", {
        viewId: "context",
        expand: [{ element: "ghost", source: "containers" }, { element: "shop", source: "deploy" }, SHOP, SHOP],
      }),
    ).rejects.toMatchObject({
      data: {
        code: "invalid_expand",
        issues: [
          { index: 0, reason: "element_unknown" },
          { index: 1, reason: "source_unrelated" },
          { index: 3, reason: "duplicate" },
        ],
      },
    });
    expect((await app.call("get_presentation_context", {})).structured["presentation"]).toMatchObject({
      viewId: "deploy",
    });
  } finally {
    app.close();
  }
});

test("expand with walkthrough is refused; the schema bounds the list; without expand nothing changes", async () => {
  const { app } = await setup();
  try {
    await expect(
      app.call("present_diagram", { viewId: "context", expand: [SHOP], walkthrough: { id: "w" } }),
    ).rejects.toMatchObject({ data: { code: "invalid_arguments" } });
    await expect(
      app.call("present_diagram", {
        viewId: "context",
        expand: Array.from({ length: 25 }, (_, i) => ({ element: `e${i}`, source: "containers" })),
      }),
    ).rejects.toMatchObject({ data: { code: "invalid_arguments" } });
    await expect(
      app.call("present_diagram", { viewId: "context", expand: [{ element: "shop" }] }),
    ).rejects.toMatchObject({ data: { code: "invalid_arguments" } });
    const plain = await app.call("present_diagram", { viewId: "context" });
    expect(plain.structured["presentation"]).not.toHaveProperty("exploration");
    expect(new URL((plain.structured["ui"] as { url: string }).url).searchParams.has("expand")).toBe(false);
    expect(plain.text).not.toMatch(/added in frames/);
    expect((await app.call("get_presentation_context", {})).structured).not.toHaveProperty("exploration");
  } finally {
    app.close();
  }
});
