// Comments on walkthroughs through the agent's tools (ADR 0034 §9): create_comment
// on a walkthrough or step, get_comments naming them, openComments on
// list_walkthroughs and write_walkthrough, and the person's thread surviving an insert.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { CommentsStore, type Place } from "../../src/comments/store.ts";
import { findProject } from "../../src/project/index.ts";
import { cleanup, repo } from "../accuracy/support.ts";

afterEach(cleanup);

const FLOW = "flowchart LR\n  a[Client]\n  b[API]\n  c[(Store)]\n  a e1@-->|Calls| b\n  b e2@-->|Writes| c\n";
const step = (title: string, edge = "e1") => ({ title, kind: "sends", what: "A request.", edges: [{ id: edge }] });
const draft = (steps: unknown[]) => ({ id: "declined-card", title: "Declined card", steps });

async function project() {
  const cwd = repo({ ".archer/flow.mmd": FLOW });
  const app = createApplication({ cwd });
  const modelRevision = async () =>
    (await app.call("read_diagram", { viewId: "flow" })).structured["modelRevision"] as string;
  const write = async (steps: unknown[], expectedRevision?: number) =>
    app.call("write_walkthrough", {
      viewId: "flow",
      modelRevision: await modelRevision(),
      walkthrough: draft(steps),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
  await write([step("Ask"), step("The card is declined", "e2")]);
  const store = new CommentsStore(findProject(cwd));
  const place: Place = {
    target: "view:flow",
    path: "flow.comments.json",
    subject: {
      kind: "view",
      elements: new Map([["edge:e2", "Writes"]]),
      walkthroughs: new Map([
        [
          "declined-card",
          {
            title: "Declined card",
            steps: [
              { id: "ask", title: "Ask" },
              { id: "the-card-is-declined", title: "The card is declined" },
            ],
          },
        ],
      ]),
    },
  };
  const onDisk = () =>
    JSON.parse(readFileSync(join(cwd, ".archer/flow.comments.json"), "utf8")) as {
      version: number;
      threads: { anchor: Record<string, unknown>; orphaned?: boolean; status: string }[];
    };
  return { cwd, app, write, store, place, onDisk };
}

test("create_comment opens a thread on a step, with the label Archer writes", async () => {
  const { app, onDisk } = await project();
  try {
    const made = await app.call("create_comment", {
      target: "view:flow",
      anchor: { kind: "step", walkthrough: "declined-card", step: "the-card-is-declined", label: "lies" },
      body: "Is this the whole story?",
    });
    expect(made.structured).toMatchObject({
      anchor: { kind: "step", step: "the-card-is-declined", label: "2. The card is declined" },
      status: "answered",
    });
    // Version 5: the thread names the drawing it was written on (`modelRevision`, 0.10.0).
    expect(onDisk().version).toBe(5);
    await expect(
      app.call("create_comment", {
        target: "view:flow",
        anchor: { kind: "step", walkthrough: "declined-card", step: "nope", label: "" },
        body: "x",
      }),
    ).rejects.toThrow(/has no step "nope"/);
  } finally {
    app.close();
  }
});

test("get_comments hands over the person's threads, naming the walkthrough and step (sent: only the listener marks them read)", async () => {
  const { app, store, place } = await project();
  try {
    store.create(place, {
      anchor: { kind: "step", walkthrough: "declined-card", step: "the-card-is-declined", label: "" },
      body: "Wrong error.",
    });
    store.create(place, {
      anchor: { kind: "walkthrough", walkthrough: "declined-card", label: "" },
      body: "Too long.",
    });
    store.create(place, { anchor: { kind: "view" }, body: "Whole diagram." });
    store.create(place, {
      anchor: {
        kind: "edge",
        id: "e2",
        label: "",
        context: { walkthrough: "declined-card", step: "the-card-is-declined" },
      },
      body: "Which store?",
    });
    store.submit();
    const got = await app.call("get_comments", { target: "view:flow" });
    expect(got.text).toContain(
      'walkthrough "Declined card" (declined-card), step 2 "The card is declined" (the-card-is-declined)',
    );
    expect(got.text).toContain('about the whole of walkthrough "Declined card" (declined-card)');
    expect(got.text).toContain("about the whole diagram");
    expect(got.text).toContain(
      'edge e2 ("Writes"), seen while stepping through walkthrough "Declined card" (declined-card), step 2 "The card is declined"',
    );
    expect((got.structured["threads"] as { status: string }[]).map((t) => t.status)).toEqual([
      "sent",
      "sent",
      "sent",
      "sent",
    ]);
  } finally {
    app.close();
  }
});

test("openComments counts sent, unresolved threads per walkthrough and step; resolving drops the count; drafts are not counted", async () => {
  const { app, store, place, write } = await project();
  try {
    const a = store.create(place, {
      anchor: { kind: "step", walkthrough: "declined-card", step: "the-card-is-declined", label: "" },
      body: "Wrong error.",
    }).value;
    store.create(place, {
      anchor: { kind: "walkthrough", walkthrough: "declined-card", label: "" },
      body: "Too long.",
    });
    expect((await app.call("list_walkthroughs", { viewId: "flow" })).structured["walkthroughs"]).toMatchObject([
      { id: "declined-card" },
    ]);
    expect(
      (
        (await app.call("list_walkthroughs", { viewId: "flow" })).structured["walkthroughs"] as Record<
          string,
          unknown
        >[]
      )[0]?.["openComments"],
    ).toBe(0);
    store.submit();
    const listed = await app.call("list_walkthroughs", { viewId: "flow" });
    expect(listed.structured["walkthroughs"]).toMatchObject([{ id: "declined-card", openComments: 2 }]);
    const detail = await app.call("list_walkthroughs", { viewId: "flow", id: "declined-card" });
    expect(detail.structured["openComments"]).toEqual({
      walkthrough: 1,
      steps: [{ id: "the-card-is-declined", step: 2, count: 1 }],
    });
    expect(detail.text).toContain("1 on step 2 (the-card-is-declined)");
    // A rewrite that keeps the step's id carries the thread with it, and the write result shows it.
    const rewritten = await write([step("Preface"), step("Ask"), step("The card is declined", "e2")], 1);
    expect(rewritten.structured["openComments"]).toEqual({
      walkthrough: 1,
      steps: [{ id: "the-card-is-declined", step: 3, count: 1 }],
    });
    const got = await app.call("get_comments", { target: "view:flow" });
    const thread = (got.structured["threads"] as { id: string; revision: number }[]).find((t) => t.id === a.id)!;
    await app.call("resolve_comment", { threadId: a.id, expectedRevision: thread.revision });
    expect(
      (await app.call("list_walkthroughs", { viewId: "flow", id: "declined-card" })).structured["openComments"],
    ).toEqual({ walkthrough: 1, steps: [] });
  } finally {
    app.close();
  }
});
