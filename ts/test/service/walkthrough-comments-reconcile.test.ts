// The service reconciles a view's comments when its walkthroughs file changes
// (ADR 0034 §9): deleting the walkthrough orphans a thread on its step, keeping
// the label, and writing it back un-orphans it. The page is told each time.
import { afterEach, expect, test } from "vitest";
import type { ThreadList } from "../../src/comments/contract.ts";
import { CommentsStore } from "../../src/comments/store.ts";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { findProject } from "../../src/project/index.ts";
import { WalkthroughsStore } from "../../src/walkthroughs/store.ts";
import { apiBase, cleanUp, events, json, project, service } from "./support.ts";

const clients: ServiceClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

const REV = `sha256:${"a".repeat(64)}`;
const PLACE = { viewId: "flow", path: "flow.walkthroughs.json" };
const STORED = {
  id: "ask",
  title: "Asking the API",
  steps: [
    { title: "Ask", kind: "sends" as const, what: "A request.", edges: [{ id: "e1", source: "a", target: "b" }] },
  ],
};

test("a thread on a step is orphaned when its walkthrough is deleted, and returns with it", async () => {
  const root = project();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const base = apiBase((await client.call("attach", { root })).url);
  const walkthroughs = new WalkthroughsStore(findProject(root));
  const stream = await events(`${base}api/events`);
  const written = walkthroughs.write(PLACE, { walkthrough: STORED, modelRevision: REV, author: "agent" });
  // The service must have seen the walkthrough before it is deleted, as it would in use.
  expect(await stream.next("walkthroughs")).toEqual({ viewId: "flow" });
  const comments = new CommentsStore(findProject(root));
  comments.create(
    {
      target: "view:flow",
      path: "flow.comments.json",
      subject: {
        kind: "view",
        elements: new Map(),
        walkthroughs: new Map([["ask", { title: "Asking the API", steps: [{ id: "ask", title: "Ask" }] }]]),
      },
    },
    { anchor: { kind: "step", walkthrough: "ask", step: "ask", label: "" }, body: "Reword this." },
  );
  const thread = async () => ((await json(`${base}api/comments?target=view:flow`)) as ThreadList).threads[0];
  // The service reconciles after its watcher settles: wait for the thread to show it.
  const until = async (orphaned: boolean) => {
    for (let i = 0; i < 100; i++) {
      if (((await thread())?.orphaned ?? false) === orphaned) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  walkthroughs.remove(PLACE, "ask", written.revision);
  await until(true);
  expect(await thread()).toMatchObject({ orphaned: true, anchor: { kind: "step", step: "ask", label: "1. Ask" } });

  walkthroughs.write(PLACE, { walkthrough: STORED, modelRevision: REV, author: "agent" });
  await until(false);
  expect((await thread())?.orphaned).toBeUndefined();
  stream.close();
});
