// The router's "· N walkthroughs" and the check's walkthrough reports (ADR 0034 §8). The router is
// generated from the folder alone, so freshness still holds; out-of-date walkthroughs and dead
// code paths are reports, never failures, as a stale .mmd is.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { removeTempDirs } from "../project/support.ts";
import { packProject } from "./pack-support.ts";

afterEach(removeTempDirs);

type Result = { text: string; structured: Record<string, unknown> };
async function withApp<T>(
  cwd: string,
  use: (call: (name: string, args: Record<string, unknown>) => Promise<Result>) => Promise<T>,
): Promise<T> {
  const app = createApplication({ cwd });
  try {
    return await use((name, args) => app.call(name, args));
  } finally {
    app.close();
  }
}
const walk = (id: string, edge: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  steps: [{ title: "Go", kind: "sends", what: "It goes.", edges: [{ id: edge }], ...extra }],
});
async function addWalkthrough(cwd: string, viewId: string, walkthrough: Record<string, unknown>) {
  await withApp(cwd, async (call) => {
    const modelRevision = (await call("read_diagram", { viewId })).structured["modelRevision"];
    await call("write_walkthrough", { viewId, modelRevision, walkthrough });
  });
}

test("a flow's router line counts its walkthroughs, folded diagram or flow diagram alike", async () => {
  const dir = packProject();
  await addWalkthrough(dir, "returns", walk("refund", "refund"));
  await addWalkthrough(dir, "checkout", walk("pay-one", "pay"));
  await addWalkthrough(dir, "checkout", walk("pay-two", "pay"));
  await withApp(dir, async (call) => {
    await call("docs_index", { write: true });
    const router = readFileSync(join(dir, ".archer/index.md"), "utf8");
    expect(router).toMatch(/\[returns\]\(diagrams\/flows\/returns\.mmd\).*· 1 walkthrough$/m);
    expect(router).toMatch(/\[Checkout\]\(notes\/flows\/checkout\.md\).*· 2 walkthroughs$/m);
    // Generated from the folder alone: freshness holds, and a change in the folder is a stale router until rewritten.
    expect(
      ((await call("docs_index", { check: true })).structured["health"] as { router: { status: string } }).router
        .status,
    ).toBe("fresh");
  });
  await addWalkthrough(dir, "returns", walk("again", "refund"));
  await withApp(dir, async (call) => {
    expect(
      ((await call("docs_index", { check: true })).structured["health"] as { router: { status: string } }).router
        .status,
    ).toBe("stale");
    await call("docs_index", { write: true });
    expect(readFileSync(join(dir, ".archer/index.md"), "utf8")).toMatch(/returns\.mmd.*· 2 walkthroughs$/m);
  });
});

test("a pack with no walkthroughs routes exactly as before", async () => {
  const dir = packProject();
  await withApp(dir, async (call) => {
    await call("docs_index", { write: true });
    expect(readFileSync(join(dir, ".archer/index.md"), "utf8")).not.toContain("walkthrough");
  });
});

test("check reports an out-of-date walkthrough and a dead code path, and still passes", async () => {
  const dir = packProject();
  await addWalkthrough(dir, "returns", walk("refund", "refund", { code: ["src/checkout.ts"] }));
  writeFileSync(
    join(dir, ".archer/diagrams/flows/returns.mmd"),
    "%% description: A returned parcel is scanned and refunded.\nflowchart LR\n  scan[Scan] done@--> refunded[Refunded]\n",
  );
  rmSync(join(dir, "src/checkout.ts"));
  await withApp(dir, async (call) => {
    const checked = await call("docs_index", { write: true, check: true });
    const health = checked.structured["health"] as {
      status: string;
      failures: string[];
      walkthroughs: { viewId: string; id: string; status: string; outOfDate: number[]; deadCode: unknown[] }[];
    };
    expect(health.walkthroughs).toMatchObject([
      { viewId: "returns", id: "refund", status: "archived", outOfDate: [1], deadCode: [{ ref: "src/checkout.ts" }] },
    ]);
    expect(health.failures.filter((f) => f.includes("walkthrough"))).toEqual([]);
    expect(checked.text).toContain("walkthrough: returns/refund is archived");
  });
});
