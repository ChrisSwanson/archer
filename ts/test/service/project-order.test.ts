// The projects are listed in the order they were attached, before and after a restart (O97). A start opens saved
// projects in parallel lanes, and the service listed them in the order they finished opening: after a restart the
// overview moved a big project (the corpus's 150-node `awkward`) from first to last, and every project after it up
// the page, so a user-flows journey that needed a scroll to reach Pageturner no longer did.

import { afterEach, expect, test } from "vitest";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, http, project, service, slugOf, write, serviceBase } from "./support.ts";

afterEach(cleanUp);

// Slow enough in Mermaid (a config copy per statement) to finish opening well after three empty projects.
const SLOWISH = `sequenceDiagram\n  participant a\n${"loop l\n  a->>a: x\nend\n".repeat(600)}`;

test("a restart lists the projects in their attach order, not the order they finished opening", async () => {
  const roots = [project(), project(), project(), project()];
  write(roots[0]!, ".archer/diagrams/slow.mmd", SLOWISH);
  const first = await service();
  const setup = await connectService(first.svc.socketPath);
  const slugs: string[] = [];
  for (const root of roots) slugs.push(slugOf((await setup.call("attach", { root })).url));
  expect((await setup.call("listProjects", {})).projects.map((p) => p.root)).toEqual(roots);
  setup.close();
  await first.svc.close();

  const second = await service({ stateDir: first.state });
  const client = await connectService(second.svc.socketPath);
  try {
    // Every project open (none still listed as opening), then the order.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const listed = (await client.call("listProjects", {})).projects;
      const open = await Promise.all(
        roots.map((root) =>
          client.call("getModel", { root, viewId: "__none__" }).then(
            () => true,
            (e: { error?: { code?: string } }) => e.error?.code !== "project_loading",
          ),
        ),
      );
      if (listed.length === roots.length && open.every(Boolean)) break;
      if (Date.now() > deadline) throw new Error("projects still opening");
      await new Promise((done) => setTimeout(done, 50));
    }
    expect((await client.call("listProjects", {})).projects.map((p) => p.root)).toEqual(roots);
    const catalog = JSON.parse((await http(`${serviceBase(second.svc.homeUrl)}api/projects`)).body) as {
      projects: { slug: string }[];
    };
    expect(catalog.projects.map((p) => p.slug)).toEqual(slugs);
  } finally {
    client.close();
  }
  await second.svc.close();
}, 60_000);
