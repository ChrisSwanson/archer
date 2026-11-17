// present_diagram's `walkthrough: {id, step?}` (ADR 0034 §5): the page opens the walkthrough at the
// step; the URL carries ?walkthrough=<id>&step=<n>. It is exclusive with `emphasis`, checks the id and
// step against the stored walkthrough, and names every problem. (Slice 4 adds the page's side.)
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, service, tempDir, write } from "../service/support.ts";

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

test("presenting a walkthrough opens it at the step, with the URL, the status and the caption", async () => {
  const { app } = await setup();
  try {
    const shown = await app.call("present_diagram", {
      viewId: "flow",
      walkthrough: { id: "ask", step: 2 },
      annotation: "The write.",
    });
    const url = new URL((shown.structured["ui"] as { url: string }).url);
    expect(url.searchParams.get("walkthrough")).toBe("ask");
    expect(url.searchParams.get("step")).toBe("2");
    expect(shown.structured["walkthrough"]).toEqual({ id: "ask", step: 2, status: "current" });
    expect(shown.structured["presentation"]).toMatchObject({ annotation: "The write." });
    expect(shown.text).toContain(url.toString());
    expect(shown.structured).not.toHaveProperty("emphasis");
    // The step defaults to 1.
    const first = await app.call("present_diagram", { viewId: "flow", walkthrough: { id: "ask" } });
    expect(first.structured["walkthrough"]).toMatchObject({ step: 1 });
    expect(new URL((first.structured["ui"] as { url: string }).url).searchParams.get("step")).toBe("1");
  } finally {
    app.close();
  }
});

test("an unknown id and a step out of range are each refused with a fix, and nothing is presented", async () => {
  const { app } = await setup();
  try {
    await expect(app.call("present_diagram", { viewId: "flow", walkthrough: { id: "asks" } })).rejects.toMatchObject({
      data: {
        code: "invalid_walkthrough",
        issues: [{ where: "walkthrough.id", fix: expect.stringContaining('Did you mean "ask"') }],
      },
    });
    await expect(
      app.call("present_diagram", { viewId: "flow", walkthrough: { id: "ask", step: 3 } }),
    ).rejects.toMatchObject({
      data: {
        code: "invalid_walkthrough",
        issues: [{ where: "walkthrough.step", problem: expect.stringContaining("2 steps") }],
      },
    });
    expect((await app.call("get_presentation_context", {})).structured["presentation"]).toBeFalsy();
  } finally {
    app.close();
  }
});

test("walkthrough and emphasis are exclusive", async () => {
  const { app } = await setup();
  try {
    await expect(
      app.call("present_diagram", { viewId: "flow", walkthrough: { id: "ask" }, emphasis: { id: "e", groups: [] } }),
    ).rejects.toMatchObject({
      data: { code: "invalid_arguments", issues: [{ path: "walkthrough" }] },
    });
  } finally {
    app.close();
  }
});

test("a partly out-of-date walkthrough is presented with its status; an archived one is presented by id alone, for the page to offer its old version", async () => {
  const { cwd, app } = await setup();
  try {
    write(cwd, ".archer/flow.mmd", FLOW.replace("  b e2@-->|Writes| c\n", ""));
    const partly = await app.call("present_diagram", { viewId: "flow", walkthrough: { id: "ask" } });
    expect(partly.structured["walkthrough"]).toEqual({ id: "ask", step: 1, status: "partly-out-of-date" });
    write(cwd, ".archer/flow.mmd", "flowchart LR\n  x[X]\n  y[Y]\n  x e9@-->|Other| y\n");
    const archived = await app.call("present_diagram", { viewId: "flow", walkthrough: { id: "ask", step: 2 } });
    expect(archived.structured["walkthrough"]).toMatchObject({ id: "ask", status: "archived" });
    const url = new URL((archived.structured["ui"] as { url: string }).url);
    expect(url.searchParams.get("walkthrough")).toBe("ask");
    // No step: an archived walkthrough opens as a whole, on the page's old-version path.
    expect(url.searchParams.has("step")).toBe(false);
    expect(archived.text).toContain("archived");
    expect(archived.text).not.toContain("at step");
    await expect(
      app.call("present_diagram", { viewId: "flow", walkthrough: { id: "ask", step: 3 } }),
    ).rejects.toMatchObject({
      data: { code: "invalid_walkthrough", issues: [{ where: "walkthrough.step" }] },
    });
  } finally {
    app.close();
  }
});
