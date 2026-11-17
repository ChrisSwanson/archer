// ADR 0028: `edit = false` in archer.toml turns page editing off. Every authoring mutation (drafts
// included) is refused as `editing_disabled` and writes nothing; reading, the editor's reads and
// comments keep working, and agents keep writing.
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { findProject, ProjectError } from "../../src/project/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { browserEditing } from "../../src/config/write-policy.ts";
import { parseGlobalConfig } from "../../src/config/index.ts";
import { apiBase, cleanUp, FLOW, http, service, tempDir, write, pageHttp } from "./support.ts";

afterEach(cleanUp);

const manifest = (edit: string) =>
  `version = 1\n${edit}\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "The flow"\nsource = ".archer/flow.mmd"\n`;

test("archer.toml takes edit = true|false; anything else is a manifest error", () => {
  const root = realpathSync(tempDir("archer-edit-"));
  write(root, ".archer/flow.mmd", FLOW);
  write(root, "archer.toml", manifest("edit = false"));
  expect(findProject(root).edit).toBe(false);
  write(root, "archer.toml", manifest("edit = true"));
  expect(findProject(root).edit).toBe(true);
  write(root, "archer.toml", manifest(""));
  expect(findProject(root).edit).toBeUndefined();
  write(root, "archer.toml", manifest('edit = "no"'));
  expect(() => findProject(root)).toThrow(ProjectError);
});

async function editor(edit: string) {
  const { svc } = await service();
  const admin = await connectService(svc.socketPath);
  const root = realpathSync(tempDir("archer-edit-"));
  write(root, "archer.toml", manifest(edit));
  write(root, ".archer/flow.mmd", FLOW);
  write(root, ".archer/diagrams/keep.mmd", FLOW);
  const attached = await admin.call("attach", { root });
  const grant = await admin.call("issueAuthoringAccess", { label: "author", projectRoots: [root] });
  const cookie = ((await pageHttp(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  const origin = new URL(svc.homeUrl).origin;
  const base = `${origin}/p/${attached.url.split(/\/(?:p|projects)\//u)[1]!.split("/")[0]!}/`;
  const headers = { cookie, origin, "content-type": "application/json" };
  const status = JSON.parse((await pageHttp(`${base}api/authoring`, { headers: { cookie } })).body) as {
    generation: string;
    edit?: unknown;
  };
  const post = (path: string, body: unknown) =>
    pageHttp(`${base}api/authoring${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(path === "" ? { journalGeneration: status.generation, ...(body as object) } : body),
    });
  return { admin, root, base, headers, status, post };
}

test("edit = false refuses every authoring mutation, keeps the editor's reads, and leaves files alone", async () => {
  const { admin, root, base, headers, status, post } = await editor("edit = false");
  try {
    expect(status.edit).toEqual({ enabled: false, reason: "project" });
    const opened = await post("/open", { target: { kind: "view", viewId: "flow" } });
    expect(opened.status, opened.body).toBe(200);
    const view = JSON.parse(opened.body) as { target: unknown; targetRevision: string; sourceRevision: string };
    const id = () => randomBytes(16).toString("hex");
    const before = readFileSync(join(root, ".archer/flow.mmd"), "utf8");
    const mutations = [
      {
        op: "document.apply",
        operationId: id(),
        target: view.target,
        expectedTargetRevision: view.targetRevision,
        expectedSourceRevision: view.sourceRevision,
        source: FLOW.replace("Client", "Edited"),
      },
      { op: "document.publish", operationId: id(), path: "diagrams/fresh.mmd", source: FLOW },
      {
        op: "draft.save",
        operationId: id(),
        draftId: `drf_${id()}`,
        expectedDraftRevision: null,
        source: FLOW,
        origin: { kind: "new", path: "diagrams/later.mmd" },
      },
      { op: "draft.send", operationId: id(), draftId: `drf_${id()}`, draftRevision: 1 },
      { op: "draft.discard", operationId: id(), draftId: `drf_${id()}`, expectedDraftRevision: 1 },
      { op: "operation.send", operationId: id(), targetOperationId: id() },
    ];
    for (const mutation of mutations) {
      const reply = await post("", mutation);
      expect([mutation.op, reply.status, JSON.parse(reply.body).error?.code], reply.body).toEqual([
        mutation.op,
        403,
        "editing_disabled",
      ]);
    }
    const layout = await post("/presentation", {
      op: "save",
      target: view.target,
      expectedTargetRevision: view.targetRevision,
      sourceRevision: view.sourceRevision,
      expectedRevision: null,
      positions: { a: { x: 1, y: 2 } },
    });
    expect([layout.status, JSON.parse(layout.body).error?.code]).toEqual([403, "editing_disabled"]);
    const read = await post("/presentation", {
      op: "read",
      target: view.target,
      expectedTargetRevision: view.targetRevision,
      sourceRevision: view.sourceRevision,
    });
    expect(read.status, read.body).toBe(200);
    expect(readFileSync(join(root, ".archer/flow.mmd"), "utf8")).toBe(before);
    const after = JSON.parse(
      (await pageHttp(`${base}api/authoring`, { headers: { cookie: headers.cookie } })).body,
    ) as {
      drafts: unknown[];
      operations: unknown[];
    };
    expect(after.drafts).toEqual([]);
    expect(after.operations).toEqual([]); // nothing journaled for any refused mutation
    // Comments still reach the agent.
    const comment = await pageHttp(`${base}api/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ target: "view:flow", anchor: { kind: "view" }, body: "Still commenting" }),
    });
    expect(comment.status, comment.body).toBe(200);
  } finally {
    admin.close();
  }
}, 20_000);

test("turning edit off while the editor is open refuses the next save", async () => {
  const { admin, root, status, post } = await editor("");
  try {
    expect(status.edit).toEqual({ enabled: true });
    const view = JSON.parse((await post("/open", { target: { kind: "view", viewId: "flow" } })).body) as {
      target: unknown;
      targetRevision: string;
      sourceRevision: string;
    };
    writeFileSync(join(root, "archer.toml"), manifest("edit = false"));
    const reply = await post("", {
      op: "document.apply",
      operationId: randomBytes(16).toString("hex"),
      target: view.target,
      expectedTargetRevision: view.targetRevision,
      expectedSourceRevision: view.sourceRevision,
      source: FLOW.replace("Client", "Edited"),
    });
    expect([reply.status, JSON.parse(reply.body).error?.code], reply.body).toEqual([403, "editing_disabled"]);
    expect(readFileSync(join(root, ".archer/flow.mmd"), "utf8")).toBe(FLOW);
  } finally {
    admin.close();
  }
}, 20_000);

test("agents keep writing when edit = false", async () => {
  const root = realpathSync(tempDir("archer-edit-"));
  write(root, "archer.toml", manifest("edit = false"));
  write(root, ".archer/flow.mmd", FLOW);
  const app = createApplication({ cwd: root });
  try {
    const read = await app.call("read_diagram", { viewId: "flow" });
    await app.call("write_diagram", {
      viewId: "flow",
      source: FLOW.replace("Client", "Agent edit"),
      expectedRevision: (read.structured as { sourceRevision: string }).sourceRevision,
    });
    expect(readFileSync(join(root, ".archer/flow.mmd"), "utf8")).toContain("Agent edit");
  } finally {
    app.close();
  }
});

test("the page creates new diagrams only under diagrams/ or notes/, making missing folders", async () => {
  const { admin, root, post } = await editor("");
  try {
    const id = () => randomBytes(16).toString("hex");
    const nested = await post("", {
      op: "document.publish",
      operationId: id(),
      path: "diagrams/payments/checkout.mmd",
      source: FLOW,
    });
    expect(nested.status, nested.body).toBe(200);
    expect(readFileSync(join(root, ".archer/diagrams/payments/checkout.mmd"), "utf8")).toBe(FLOW);
    const top = await post("", { op: "document.publish", operationId: id(), path: "top.mmd", source: FLOW });
    expect([top.status, JSON.parse(top.body).error?.code], top.body).toEqual([403, "create_not_allowed"]);
    expect(() => readFileSync(join(root, ".archer/top.mmd"))).toThrow();
  } finally {
    admin.close();
  }
}, 20_000);

// D1 (decided 2026-10-31; C-04): archiving or showing a project is a change to it, so it follows the edit
// switch like Edit and New: refused where `edit = false`, read fresh at each request.
test("edit = false refuses every project lifecycle change, read fresh; edit on allows it", async () => {
  const { admin, root, headers } = await editor("edit = false");
  try {
    const catalog = JSON.parse(
      (await pageHttp(`${new URL(headers.origin).origin}/api/projects`, { headers: { cookie: headers.cookie } })).body,
    ) as { projects: { slug: string; root?: string }[] };
    const slug = catalog.projects[0]!.slug;
    const change = (action: string) =>
      pageHttp(`${headers.origin}/api/project-lifecycle`, {
        method: "POST",
        headers,
        body: JSON.stringify({ slug, action }),
      });
    for (const action of ["archive", "show", "auto"]) {
      const reply = await change(action);
      expect([action, reply.status, JSON.parse(reply.body).error?.code], reply.body).toEqual([
        action,
        403,
        "editing_disabled",
      ]);
    }
    const unchanged = JSON.parse(
      (await pageHttp(`${headers.origin}/api/projects`, { headers: { cookie: headers.cookie } })).body,
    ) as { projects: { slug: string; lifecycle: { visibility: string } }[] };
    expect(unchanged.projects.find((p) => p.slug === slug)?.lifecycle.visibility).toBe("auto");
    writeFileSync(join(root, "archer.toml"), manifest(""));
    const archived = await change("archive");
    expect(archived.status, archived.body).toBe(200);
    writeFileSync(join(root, "archer.toml"), manifest("edit = false"));
    expect((await change("show")).status).toBe(403);
    // An unknown project is still a 404, before any edit switch is read.
    const unknown = await pageHttp(`${headers.origin}/api/project-lifecycle`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug: "no-such-project", action: "show" }),
    });
    expect(unknown.status).toBe(404);
  } finally {
    admin.close();
  }
}, 20_000);

// G3 matrix (security round 1, batch 4): archive and show are an Edit-cell change, and a grant's Bearer never
// makes one (rubric §1), even with editing on. The owner's path token, like a cookie, may.
test("archive and show refuse a grant's Bearer with editing on; a grant's cookie and the owner's session may", async () => {
  const { svc } = await service();
  const admin = await connectService(svc.socketPath);
  try {
    const root = realpathSync(tempDir("archer-edit-"));
    write(root, "archer.toml", manifest(""));
    write(root, ".archer/flow.mmd", FLOW);
    await admin.call("attach", { root });
    const grant = await admin.call("issueAuthoringAccess", { label: "author", projectRoots: [root] });
    const secret = new URL(grant.url).searchParams.get("token")!;
    const origin = new URL(svc.homeUrl).origin;
    const cookie = ((await pageHttp(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const slug = (
      JSON.parse((await pageHttp(`${origin}/api/projects`, { headers: { cookie } })).body) as {
        projects: { slug: string }[];
      }
    ).projects[0]!.slug;
    const body = JSON.stringify({ slug, action: "archive" });
    const json = { origin, "content-type": "application/json" };
    const bearer = await pageHttp(`${origin}/api/project-lifecycle`, {
      method: "POST",
      headers: { ...json, authorization: `Bearer ${secret}` },
      body,
    });
    expect(bearer.status).toBe(404);
    const visibility = async () =>
      (
        JSON.parse((await pageHttp(`${origin}/api/projects`, { headers: { cookie } })).body) as {
          projects: { slug: string; lifecycle: { visibility: string } }[];
        }
      ).projects.find((p) => p.slug === slug)?.lifecycle.visibility;
    expect(await visibility()).toBe("auto");
    // The browser cookie, with editing on, still archives.
    expect(
      (await pageHttp(`${origin}/api/project-lifecycle`, { method: "POST", headers: { ...json, cookie }, body }))
        .status,
    ).toBe(200);
    expect(await visibility()).toBe("hidden");
    // The owner's browser, signed in by the agent's link, shows it again.
    const owner = ((await pageHttp(svc.homeUrl)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const shown = await pageHttp(`${origin}/api/project-lifecycle`, {
      method: "POST",
      headers: { ...json, cookie: owner },
      body: JSON.stringify({ slug, action: "show" }),
    });
    expect(shown.status, shown.body).toBe(200);
    expect(await visibility()).toBe("visible");
  } finally {
    admin.close();
  }
}, 20_000);

// C-30 (security re-score 1, A2-4): `edit = false` written after a table header is that table's key in
// TOML, not the project's. It is reported with its line, never silently ignored, and editing is off
// until it is moved (fail closed).
test("an edit written under [[views]] is a problem naming its line, and editing is off until it moves", () => {
  const root = realpathSync(tempDir("archer-edit-"));
  write(root, ".archer/flow.mmd", FLOW);
  write(root, "archer.toml", `${manifest("")}edit = false\n`);
  const project = findProject(root);
  expect(project.edit).toBe(false);
  expect(project.problems).toEqual([
    expect.objectContaining({
      position: 1,
      id: "flow",
      message: expect.stringMatching(
        /^line 9: `edit` is under the \[\[views\]\] header on line 4, .*move it above the first \[table\] header.*creating and editing in the page are off/u,
      ),
    }),
  ]);
  expect(browserEditing(project)).toEqual({ enabled: false, source: "project" });
  // Even when it says true: what the person meant is unclear, so editing stays off until the line moves.
  write(root, "archer.toml", `${manifest("edit = true")}edit = true\n`);
  expect(findProject(root).edit).toBe(false);
});

test("an edit written under any other table is a manifest error naming its line", () => {
  const root = realpathSync(tempDir("archer-edit-"));
  write(root, ".archer/flow.mmd", FLOW);
  write(root, "archer.toml", `version = 1\n\n[discovery]\nroots = ["docs"]\nedit = false\n`);
  expect(() => findProject(root)).toThrow(/line 5: `edit` is under the \[discovery\] header on line 3/u);
});

test("the account's archer.toml: an edit under a table names its line", () => {
  expect(() => parseGlobalConfig(`version = 1\n\n[service]\nport = 4000\nedit = false\n`)).toThrow(
    /line 5: `edit` is under the \[service\] header on line 3/u,
  );
  expect(() => parseGlobalConfig(`version = 1\n[[projects]]\npath = "/x"\nedit = false\n`)).toThrow(
    /line 4: `edit` is under the \[\[projects\]\] header on line 2/u,
  );
  expect(parseGlobalConfig(`version = 1\nedit = false\n[service]\nport = 4000\n`).edit).toBe(false);
});

test("the settings snapshot shows the misplaced edit as a problem and editing as off", async () => {
  const { svc } = await service();
  const admin = await connectService(svc.socketPath);
  const root = realpathSync(tempDir("archer-edit-"));
  write(root, "archer.toml", `${manifest("")}edit = false\n`);
  write(root, ".archer/flow.mmd", FLOW);
  try {
    const attached = await admin.call("attach", { root });
    const reply = await pageHttp(`${apiBase(attached.url)}api/project-settings`);
    expect(reply.status, reply.body).toBe(200);
    const snapshot = JSON.parse(reply.body) as { general: { editing: unknown }; viewProblems: { message: string }[] };
    expect(snapshot.general.editing).toEqual({ enabled: false, source: "project" });
    expect(snapshot.viewProblems.map((problem) => problem.message)).toEqual([
      expect.stringMatching(/^line 9: `edit` is under the \[\[views\]\] header on line 4/u),
    ]);
  } finally {
    admin.close();
  }
});
