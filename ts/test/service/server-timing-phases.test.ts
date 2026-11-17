// Performance rubric S9: each route's Server-Timing phases account for its handler time. The project catalog, the
// authoring status and a note's embedded diagram had only `auth` named while most of their time went unnamed.
import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { findProject } from "../../src/project/index.ts";
import { WalkthroughsStore } from "../../src/walkthroughs/store.ts";
import { cleanUp, http, project, service, write } from "./support.ts";

afterEach(cleanUp);

const phases = (header: unknown): string[] =>
  String(header ?? "")
    .split(", ")
    .map((part) => part.split(";")[0]!)
    .filter((name) => name !== "total");

test("debug on: the catalog, authoring status and an embedded diagram name the phases their time goes to", async () => {
  const { svc } = await service({ env: { ARCHER_DEBUG: "1" } });
  const client = await connectService(svc.socketPath);
  try {
    const root = project();
    write(root, ".archer/notes/n.md", "# N\n\n```mermaid\n%% archer-id: f\nflowchart LR\n  a --> b\n```\n");
    const attached = await client.call("attach", { root });
    const slug = attached.url.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
    const grant = await client.call("issueAuthoringAccess", { label: "timing", projectRoots: [root] });
    const cookie = ((await http(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const base = new URL(svc.homeUrl).origin;
    const get = async (path: string): Promise<string[]> => {
      const reply = await http(`${base}${path}`, { headers: { cookie, "accept-encoding": "br" } });
      expect(reply.status, `${path}: ${reply.body}`).toBe(200);
      return phases(reply.headers["server-timing"]);
    };
    for (const path of ["/api/browser-projects", `/p/${slug}/api/browser-projects`])
      expect(await get(path)).toEqual(expect.arrayContaining(["auth", "catalog", "encode", "compress"]));
    expect(await get(`/p/${slug}/api/authoring`)).toEqual(
      expect.arrayContaining(["auth", "admit", "project", "store", "encode"]),
    );
    expect(await get(`/p/${slug}/api/notes/diagram?address=${encodeURIComponent("notes/n.md#f")}`)).toEqual(
      expect.arrayContaining(["auth", "read", "compile", "freshness", "encode"]),
    );
    // The reads of a project's lists, a note and its threads name the work before the answer is encoded (O196).
    for (const path of [
      `/p/${slug}/api/diagrams`,
      `/p/${slug}/api/comment-activity`,
      `/p/${slug}/api/comments/pending`,
      `/p/${slug}/api/notes/content?path=${encodeURIComponent("notes/n.md")}`,
      `/p/${slug}/api/note-emphases?path=${encodeURIComponent("notes/n.md")}`,
    ])
      expect(await get(path), path).toEqual(expect.arrayContaining(["auth", "read", "encode"]));
    // A view's walkthroughs: the file read, their resolution against the model and the dead-code check (r3 S9: 88%
    // named, 4.5 ms unnamed at most).
    new WalkthroughsStore(findProject(root)).write(
      { viewId: "flow", path: "flow.walkthroughs.json" },
      {
        walkthrough: {
          id: "ask",
          title: "Asking",
          steps: [
            {
              title: "Ask",
              kind: "sends",
              what: "A request.",
              edges: [{ id: "e1", source: "a", target: "b" }],
              code: ["src/missing.ts"],
            },
          ],
        },
        modelRevision: `sha256:${"a".repeat(64)}`,
        author: "agent",
      },
    );
    expect(await get(`/p/${slug}/api/walkthroughs?viewId=flow`)).toEqual(
      expect.arrayContaining(["auth", "read", "resolve", "dead-code", "encode"]),
    );
    // The old model a walkthrough was written on: the walkthroughs read, then the search in Git (claude-307).
    expect(await get(`/p/${slug}/api/walkthroughs/old?viewId=flow&id=ask`)).toEqual(
      expect.arrayContaining(["auth", "read", "git", "encode"]),
    );
    // Search, the browser's document search and a view's emphasis name their read (claude-307).
    for (const path of [
      `/p/${slug}/api/search?q=ask`,
      `/p/${slug}/api/browser-search?q=ask`,
      `/p/${slug}/api/emphasis/flow`,
    ])
      expect(await get(path), path).toEqual(expect.arrayContaining(["auth", "read", "encode"]));
    // The page document: finding its route, reading its bytes and preparing its copies.
    expect(await get(`/projects/${slug}/notes/n.md`)).toEqual(
      expect.arrayContaining(["auth", "route", "read", "encode"]),
    );
  } finally {
    client.close();
  }
});
