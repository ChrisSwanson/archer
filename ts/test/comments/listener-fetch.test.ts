// "Read by the agent" means the checkout's listener fetched it (ADR 0035 §7): getComments marks threads
// read only when asked as the listener, and says so only then.
import { afterEach, expect, test } from "vitest";
import { getComments, wherePhrase } from "../../src/comments/agent.ts";
import { CommentsStore, type Place } from "../../src/comments/store.ts";
import { findProject } from "../../src/project/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test("only the listener's fetch moves sent threads to read", () => {
  const project = findProject(tempDir({ ".archer/flow.mmd": FLOW }));
  const store = new CommentsStore(project);
  const place: Place = { target: "view:flow", path: "flow.comments.json", subject: { kind: "view", elements: null } };
  const thread = store.create(place, { anchor: { kind: "view" }, body: "Why?" }).value;
  store.submit();
  const other = getComments(project);
  expect(other.text).not.toContain("now sees them as read");
  expect(store.list(place).threads[0]?.status).toBe("sent");
  const listener = getComments(project, undefined, { asListener: true });
  expect(listener.text).toContain("the person now sees them as read");
  expect(listener.structured["threads"]).toMatchObject([{ id: thread.id, status: "read" }]);
  expect(store.list(place).threads[0]?.status).toBe("read");
});

test("the where phrase is the agent's Where: line without its label", () => {
  expect(
    wherePhrase({
      file: ".archer/flow.mmd",
      address: "flow",
      lines: { start: 2, end: 2 },
      page: "/projects/demo/",
    } as never),
  ).toBe("file .archer/flow.mmd, address flow, line 2, sent from /projects/demo/");
  expect(wherePhrase({} as never)).toBe("");
});
