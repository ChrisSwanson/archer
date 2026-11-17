// The link the agent hands over names what it presented (decided 2026-11-02; user-flows round 1, claude-08): the
// diagram's own address (its file, or its note and name), with the walkthrough step or the emphasis it showed, so
// it opens that diagram after the agent presents something else. Following the agent stays one deliberate step
// away: `followUrl`, the `?follow` address, which old links still use.
import { afterEach, expect, test } from "vitest";
import { createApplication, type Application } from "../../src/application/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, http, openPage, project, service, write } from "../service/support.ts";

const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await cleanUp();
});

async function setup(files: Readonly<Record<string, string>> = {}) {
  const root = project();
  for (const [path, text] of Object.entries(files)) write(root, path, text);
  const { svc } = await service();
  const app = createApplication({
    cwd: root,
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  });
  apps.push(app);
  return { app };
}
const urls = (result: { structured: Record<string, unknown> }) =>
  result.structured["ui"] as { url: string; followUrl?: string };
const slugOf = (url: string) => new URL(url).pathname.split("/")[2]!;

test("present_diagram returns the diagram's own address with the token once, and the follow address beside it", async () => {
  const { app } = await setup();
  const shown = await app.call("present_diagram", { viewId: "flow" });
  const { url, followUrl } = urls(shown);
  const link = new URL(url);
  const slug = slugOf(url);
  expect(link.pathname).toBe(`/projects/${slug}/flow.mmd`);
  expect(link.searchParams.get("token")).toMatch(/^[0-9a-f]{32}(?:[0-9a-f]{32})?$/);
  expect([...link.searchParams.keys()]).toEqual(["token"]);
  expect(shown.text).toContain(`\n${url}`);
  // Following the agent is still one address away, and only when chosen.
  expect(followUrl).toBe(`${link.origin}/projects/${slug}/?follow&token=${link.searchParams.get("token")}`);
  expect(shown.text).not.toContain(followUrl);
  // The link signs in and lands on the diagram's clean address, whatever is presented next.
  await app.call("present_diagram", { viewId: "chat" });
  const exchange = await http(url);
  expect(exchange.status).toBe(303);
  expect(exchange.headers.location).toBe(`/projects/${slug}/flow.mmd`);
  expect((await openPage(url)).status).toBe(200);
  // An old `?follow` link keeps working.
  expect((await openPage(followUrl!)).status).toBe(200);
});

test("the emphasis it presented rides the stable link (a walkthrough step does too: walkthrough-steering.test.ts)", async () => {
  const { app } = await setup();
  const emphasised = await app.call("present_diagram", {
    viewId: "flow",
    emphasis: { id: "the path", groups: [{ id: "g", style: "flow", label: "Path", nodes: ["a", "b"], edges: ["e1"] }] },
  });
  const link = new URL(urls(emphasised).url);
  expect(link.pathname).toMatch(/\/flow\.mmd$/);
  expect(link.searchParams.get("emphasis")).toBe("the path");
  expect(link.search).toMatch(/^\?token=[0-9a-f]+&emphasis=the%20path$/);
});

test("a diagram in a note: its note's address and name; get_ui_url: the project page, not the agent's", async () => {
  const note =
    "---\nauthor: agent\n---\n# Credentials\n\n```mermaid\n%% archer-id: vault\nflowchart LR\n  a[Vault] e1@--> b[API]\n```\n";
  const { app } = await setup({ ".archer/notes/ops/credentials guide.md": note });
  const shown = await app.call("present_diagram", { viewId: "notes/ops/credentials guide.md#vault" });
  const link = new URL(urls(shown).url);
  expect(link.pathname).toBe(`/projects/${slugOf(link.href)}/notes/ops/credentials%20guide.md`);
  expect(link.hash).toBe("#vault");
  expect([...link.searchParams.keys()]).toEqual(["token"]);
  expect((await openPage(link.href)).status).toBe(200);

  const page = await app.call("get_ui_url", {});
  const project = new URL(String(page.structured["url"]));
  expect(project.pathname).toBe(`/projects/${slugOf(project.href)}/`);
  expect([...project.searchParams.keys()]).toEqual(["token"]);
  expect(page.structured["followUrl"]).toBe(
    `${project.origin}${project.pathname}?follow&token=${project.searchParams.get("token")}`,
  );
});
