// What an agent needs next is in the default text of create_comment, reply_comment, list_emphases and
// read_diagram, not only in structuredContent, which some clients drop.
import { afterEach, expect, test } from "vitest";
import { call, connect, FLOW, removeTempDirs, SEQ, tempDir, text } from "../mcp/support.ts";

afterEach(removeTempDirs);

test("create_comment's text states the thread's revision; reply_comment's says a reply leaves it unchanged", async () => {
  const root = tempDir({ ".archer/auth.md": "# Auth\n\nTokens.\n" });
  const { client, close } = await connect({ cwd: root });
  const created = await call(client, "create_comment", {
    target: "note:auth.md",
    anchor: { kind: "view" },
    body: "Hi.",
  });
  expect(text(created)).toMatch(/revision 1\b/);
  const id = String((created.structuredContent as { id: string }).id);
  const replied = await call(client, "reply_comment", { threadId: id, body: "More.", expectedRevision: 1 });
  expect(text(replied)).toMatch(/revision 1\b[^.]*unchanged|unchanged[^.]*revision 1\b/);
  await close();
});

test("list_emphases names the views it covers and where the full listing is", async () => {
  const { client, close } = await connect({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  expect(text(await call(client, "list_emphases"))).toMatch(/outputFormat: ?"?text/);
  await close();
});

test("read_diagram's text of a sequence says how to get message and fragment ids", async () => {
  const { client, close } = await connect({ cwd: tempDir({ ".archer/seq.mmd": SEQ }) });
  expect(text(await call(client, "read_diagram", { viewId: "seq" }))).toMatch(
    /outputFormat: ?"?text[^.]*(message|id)/i,
  );
  await close();
});
