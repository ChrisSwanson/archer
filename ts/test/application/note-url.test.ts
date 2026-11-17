// A note's page URL: present_diagram of an embedded diagram returns it as noteUrl, and
// get_ui_url gives it for a notePath without presenting anything. Both open the note's page.
import { afterEach, expect, test } from "vitest";
import { createApplication, type Application } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, openPage, project, service, write } from "../service/support.ts";

const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await cleanUp();
});

const NOTE =
  "---\nauthor: agent\n---\n# Credentials\n\nSteps.\n\n```mermaid\n%% archer-id: flow\nflowchart LR\n  a[Vault] e1@--> b[API]\n```\n";

test("present_diagram of a diagram in a note also returns the note's page URL", async () => {
  const root = project();
  write(root, ".archer/notes/ops/credentials guide.md", NOTE);
  const { svc } = await service();
  const app = createApplication({ cwd: root, ensureService: () => connectService(svc.socketPath) });
  apps.push(app);
  const presented = await app.call("present_diagram", { viewId: "notes/ops/credentials guide.md#flow" });
  const url = new URL(String(presented.structured["ui"] && (presented.structured["ui"] as { url: string }).url));
  const noteUrl = String(presented.structured["noteUrl"]);
  const note = new URL(noteUrl);
  expect(note.origin).toBe(url.origin);
  // The presented diagram's own link is its note's address and name (claude-08); noteUrl is the note alone.
  expect(note.pathname).toBe(url.pathname);
  expect(url.hash).toBe("#flow");
  expect(note.pathname).toMatch(/^\/projects\/[a-z0-9-]+\/notes\/ops\/credentials%20guide\.md$/);
  expect(note.searchParams.get("token")).toBe(url.searchParams.get("token"));
  expect(note.searchParams.has("follow")).toBe(false);
  expect(presented.text.split("\n")).toEqual(expect.arrayContaining([url.href, noteUrl]));
  expect(presented.text).toContain(`Its note's page:\n${noteUrl}`);
  expect((await openPage(noteUrl)).status).toBe(200);
  // A diagram file has no note.
  const file = await app.call("present_diagram", { viewId: "flow" });
  expect(file.structured["noteUrl"]).toBeUndefined();
});

test("get_ui_url with a notePath gives that note's page URL; an unknown note is refused", async () => {
  const root = project();
  write(root, ".archer/notes/credentials.md", "---\nauthor: agent\n---\n# Credentials\n");
  const { svc } = await service();
  const app = createApplication({ cwd: root, ensureService: () => connectService(svc.socketPath) });
  apps.push(app);
  const answer = await app.call("get_ui_url", { notePath: "notes/credentials.md" });
  const url = new URL(String(answer.structured["url"]));
  expect(url.pathname).toMatch(/^\/projects\/[a-z0-9-]+\/notes\/credentials\.md$/);
  expect(url.searchParams.get("token")).toMatch(/\S/);
  expect(answer.text).toContain(String(answer.structured["url"]));
  expect((await openPage(String(answer.structured["url"]))).status).toBe(200);
  await expect(app.call("get_ui_url", { notePath: "notes/missing.md" })).rejects.toMatchObject({
    data: { code: expect.any(String) },
  });
  // Without one, the project's own page; following the agent is its followUrl (claude-08).
  const page = await app.call("get_ui_url");
  expect(new URL(String(page.structured["url"])).searchParams.has("follow")).toBe(false);
  expect(new URL(String(page.structured["followUrl"])).searchParams.has("follow")).toBe(true);
});

test("a note path the page cannot address (a first segment of -) gets no note URL, and get_ui_url refuses it", async () => {
  const root = project();
  write(root, ".archer/-/repo/credentials.md", NOTE);
  const { svc } = await service();
  const app = createApplication({ cwd: root, ensureService: () => connectService(svc.socketPath) });
  apps.push(app);
  const presented = await app.call("present_diagram", { viewId: "-/repo/credentials.md#flow" });
  expect(presented.structured["noteUrl"]).toBeUndefined();
  await expect(app.call("get_ui_url", { notePath: "-/repo/credentials.md" })).rejects.toMatchObject({
    data: { code: "invalid_arguments" },
  });
});
