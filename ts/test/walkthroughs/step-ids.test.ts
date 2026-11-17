// Step ids (ADR 0034 §9): a comment follows a step through an insert, so each
// step has a stable id. A write without one keeps the id of the stored step
// with the same title, else slugs the title; an echoed id is kept; a stored
// step always has one.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanup, repo } from "../accuracy/support.ts";

afterEach(cleanup);

const FLOW = "flowchart LR\n  a[Client]\n  b[API]\n  c[(Store)]\n  a e1@-->|Calls| b\n  b e2@-->|Writes| c\n";
const SIDECAR = ".archer/flow.walkthroughs.json";
const step = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  kind: "sends",
  what: "A request.",
  edges: [{ id: "e1" }],
  ...extra,
});
const draft = (steps: unknown[]) => ({ id: "ask", title: "Asking the API", steps });

function project() {
  const cwd = repo({ ".archer/flow.mmd": FLOW });
  const app = createApplication({ cwd });
  const modelRevision = async () =>
    (await app.call("read_diagram", { viewId: "flow" })).structured["modelRevision"] as string;
  const write = async (walkthrough: unknown, expectedRevision?: number) =>
    app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: await modelRevision(),
      walkthrough,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  const ids = (result: { structured: Record<string, unknown> }) =>
    (result.structured["walkthrough"] as { steps: { id: string }[] }).steps.map((s) => s.id);
  return { cwd, app, write, ids };
}

test("a step without an id is slugged from its title; a clash gets -2", async () => {
  const { app, write, ids } = project();
  try {
    expect(
      ids(
        await write(
          draft([step("The card is declined"), step("The card is declined"), step("Store", { edges: [{ id: "e2" }] })]),
        ),
      ),
    ).toEqual(["the-card-is-declined", "the-card-is-declined-2", "store"]);
  } finally {
    app.close();
  }
});

test("a rewrite keeps the id of the stored step with the same title, through an insert", async () => {
  const { app, write, ids } = project();
  try {
    await write(draft([step("First"), step("Second", { edges: [{ id: "e2" }] })]));
    const second = await write(draft([step("Inserted"), step("First"), step("Second", { edges: [{ id: "e2" }] })]), 1);
    expect(ids(second)).toEqual(["inserted", "first", "second"]);
  } finally {
    app.close();
  }
});

test("an echoed id is kept even when the title changed", async () => {
  const { app, write, ids } = project();
  try {
    await write(draft([step("First")]));
    expect(ids(await write(draft([step("Reworded", { id: "first" })]), 1))).toEqual(["first"]);
  } finally {
    app.close();
  }
});

test("a duplicate or malformed id is refused with every issue", async () => {
  const { cwd, app, write } = project();
  try {
    await expect(write(draft([step("A", { id: "x" }), step("B", { id: "x" })]))).rejects.toMatchObject({
      data: { code: "invalid_walkthrough", issues: [{ where: "steps[1].id" }] },
    });
    await expect(write(draft([step("A", { id: "Bad Id" })]))).rejects.toMatchObject({
      data: { code: "invalid_walkthrough", issues: [{ where: "steps[0].id" }] },
    });
    expect(() => readFileSync(join(cwd, SIDECAR))).toThrow();
  } finally {
    app.close();
  }
});

test("a stored step without an id makes the file malformed: Archer writes every step's id", async () => {
  const { cwd, app, write } = project();
  try {
    await write(draft([step("First"), step("Second", { edges: [{ id: "e2" }] })]));
    const file = JSON.parse(readFileSync(join(cwd, SIDECAR), "utf8"));
    expect(file.walkthroughs[0].steps.map((s: { id: string }) => s.id)).toEqual(["first", "second"]);
    delete file.walkthroughs[0].steps[1].id;
    writeFileSync(join(cwd, SIDECAR), JSON.stringify(file, null, 2) + "\n");
    await expect(app.call("list_walkthroughs", { viewId: "flow", id: "ask" })).rejects.toMatchObject({
      data: { code: "malformed_walkthroughs_file" },
    });
  } finally {
    app.close();
  }
});

test("a stored custom id is lent to a rewrite without ids by title, not re-slugged", async () => {
  const { app, write, ids } = project();
  try {
    await write(draft([step("First", { id: "pay" }), step("Second", { edges: [{ id: "e2" }] })]));
    // A slug of "First" is "first": only the title lending can give back "pay".
    expect(ids(await write(draft([step("Second", { edges: [{ id: "e2" }] }), step("First")]), 1))).toEqual([
      "second",
      "pay",
    ]);
  } finally {
    app.close();
  }
});
