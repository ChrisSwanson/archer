// ADR 0013's write rules, enforced on every Archer-owned write surface (ADR 0028): with a rule
// false, the surface is refused as `write_rule_denied` and the project's files are byte-identical.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { configureWritePolicy, rulesFrom, WRITE_RULES, type WriteRule } from "../../src/config/write-policy.ts";
import { initProject } from "../../src/project/init.ts";
import { revisionOf } from "../../src/project/index.ts";
import { connectService } from "../../src/service/service-client.ts";
import { apiBase, cleanUp, service, tempDir, write, pageHttp } from "../service/support.ts";

afterEach(cleanUp);

const FLOW = "flowchart LR\n  a[Client] e1@--> b[API]\n";
const FLOW_OLD = "flowchart LR\n  a[A (x)]\n  b[B]\n  e@a --> b\n";
const NOTE =
  "# Note\n\nA passage about tokens.\n\n```mermaid\n%% archer-id: pinned\nflowchart LR\n  a[A] e1@--> b[B]\n```\n\n```mermaid\nflowchart LR\n  c[C] e1@--> d[D]\n```\n";
const MANIFEST =
  'version = 1\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "The flow"\nsource = ".archer/flow.mmd"\n';

function fixture(): string {
  const root = realpathSync(tempDir("archer-rules-"));
  write(root, "archer.toml", MANIFEST);
  write(root, ".archer/flow.mmd", FLOW);
  write(root, ".archer/old.mmd", FLOW_OLD);
  write(root, ".archer/loose.mmd", FLOW);
  write(root, ".archer/note.md", NOTE);
  return root;
}
const brokenConfigs: { path: string; break: () => void }[] = [];
function configWith(root: string, rule: string): string {
  const path = write(tempDir(), "archer.toml", `version = 1\n[[projects]]\npath = ${JSON.stringify(root)}\n${rule}\n`);
  brokenConfigs.push({
    path,
    break: () => {
      writeFileSync(path, "version = 1\n[[projects]\n");
    },
  });
  return path;
}
/** Every file under the project, with its bytes: the whole effect of a refused write must be none. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "latin1");
    }
  };
  walk(root);
  return out;
}

test("rules default to true, read_only flips the defaults, and register needs manifest", () => {
  expect(rulesFrom(undefined)).toEqual(Object.fromEntries(WRITE_RULES.map((rule) => [rule, true])));
  expect(rulesFrom({ path: "/p", readOnly: true })).toEqual(
    Object.fromEntries(WRITE_RULES.map((rule) => [rule, false])),
  );
  expect(rulesFrom({ path: "/p", readOnly: true, comments: true })).toMatchObject({ comments: true, diagrams: false });
  expect(rulesFrom({ path: "/p", manifest: false })).toMatchObject({
    register: false,
    manifest: false,
    diagrams: true,
  });
});

type Surface = {
  readonly name: string;
  readonly rule: WriteRule;
  readonly run: (root: string, config: string) => Promise<unknown>;
};

const agentSurfaces: readonly Surface[] = [
  {
    name: "MCP write_diagram (standalone)",
    rule: "diagrams",
    run: async (root) => {
      const app = createApplication({ cwd: root });
      try {
        return await app.call("write_diagram", {
          viewId: "flow",
          source: FLOW.replace("Client", "Edited"),
          expectedRevision: revisionOf(Buffer.from(FLOW)),
        });
      } finally {
        app.close();
      }
    },
  },
  {
    name: "MCP write_diagram (embedded)",
    rule: "notes",
    run: async (root) => {
      const app = createApplication({ cwd: root });
      try {
        const read = await app.call("read_diagram", { viewId: "note.md#pinned" });
        return await app.call("write_diagram", {
          viewId: "note.md#pinned",
          source: String((read.structured as { source: { text: string } }).source.text).replace("[A]", "[Edited]"),
          expectedRevision: (read.structured as { sourceRevision: string }).sourceRevision,
        });
      } finally {
        app.close();
      }
    },
  },
  {
    name: "MCP register_diagram",
    rule: "register",
    run: async (root) => {
      const app = createApplication({ cwd: root });
      try {
        return await app.call("register_diagram", { sourcePath: "loose.mmd" });
      } finally {
        app.close();
      }
    },
  },
  {
    name: "MCP register_diagram (manifest)",
    rule: "manifest",
    run: async (root) => {
      const app = createApplication({ cwd: root });
      try {
        return await app.call("register_diagram", { sourcePath: "loose.mmd" });
      } finally {
        app.close();
      }
    },
  },
  {
    name: "MCP create_comment",
    rule: "comments",
    run: async (root) => {
      const app = createApplication({ cwd: root });
      try {
        return await app.call("create_comment", {
          target: "note:note.md",
          anchor: { kind: "view" },
          body: "Agent question",
        });
      } finally {
        app.close();
      }
    },
  },
  {
    name: "MCP set_note_emphasis",
    rule: "emphasis",
    run: async (root) => {
      const app = createApplication({ cwd: root });
      const passage = { kind: "passage", quote: "tokens", prefix: "A passage about ", suffix: "." };
      try {
        return await app.call("set_note_emphasis", {
          notePath: "note.md",
          id: "e",
          title: "E",
          groups: [{ id: "g", label: "G", description: "D", passages: [passage] }],
          expectedRevision: 0,
        });
      } finally {
        app.close();
      }
    },
  },
  { name: "archer init", rule: "manifest", run: async (root) => initProject(root) },
];

for (const surface of agentSurfaces)
  for (const setting of [`${surface.rule} = false`, "read_only = true"]) {
    test(`${surface.name} is refused when ${setting} and writes nothing`, async () => {
      const root = fixture();
      const before = snapshot(root);
      const config = configWith(root, setting);
      const restore = configureWritePolicy({ env: { ARCHER_CONFIG: config } });
      try {
        const failure = await surface.run(root, config).then(
          () => null,
          (error: unknown) => error as { code?: unknown; data?: { code?: unknown; rule?: unknown } },
        );
        expect(failure?.data?.code ?? failure?.code).toBe("write_rule_denied");
        if (failure?.data !== undefined && setting !== "read_only = true") expect(failure.data.rule).toBe(surface.rule);
      } finally {
        restore();
      }
      expect(snapshot(root)).toEqual(before);
    });
  }

test("an unreadable account configuration refuses writes instead of allowing them", async () => {
  const root = fixture();
  const before = snapshot(root);
  const restore = configureWritePolicy({
    env: { ARCHER_CONFIG: write(tempDir(), "archer.toml", "version = 1\n[[projects]\n") },
  });
  try {
    const app = createApplication({ cwd: root });
    try {
      await expect(
        app.call("create_comment", { target: "note:note.md", anchor: { kind: "view" }, body: "Q" }),
      ).rejects.toMatchObject({ data: { code: "write_rule_denied" } });
    } finally {
      app.close();
    }
  } finally {
    restore();
  }
  expect(snapshot(root)).toEqual(before);
});

test("a rule for another project leaves this one writable", async () => {
  const root = fixture();
  const restore = configureWritePolicy({ env: { ARCHER_CONFIG: configWith("/somewhere/else", "read_only = true") } });
  const app = createApplication({ cwd: root });
  try {
    await expect(
      app.call("create_comment", { target: "note:note.md", anchor: { kind: "view" }, body: "Q" }),
    ).resolves.toBeDefined();
  } finally {
    app.close();
    restore();
  }
});

async function browser(root: string, rule: string) {
  const { svc } = await service({ env: { ARCHER_CONFIG: configWith(root, rule) } });
  const admin = await connectService(svc.socketPath);
  const attached = await admin.call("attach", { root });
  const origin = new URL(svc.homeUrl).origin;
  // The owner's browser: its agent link signs it in (`http` then sends the session cookie to this origin).
  const base = apiBase(attached.url);
  const post = (path: string, body: unknown) =>
    pageHttp(`${base}${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { svc, admin, base, origin, post };
}

test.each([
  [
    "comments = false",
    "api/comments",
    { target: "note:note.md", anchor: { kind: "view" }, body: "A person's comment" },
  ],
  [
    "emphasis = false",
    "api/note-emphases?path=note.md",
    {
      notePath: "note.md",
      id: "e",
      title: "E",
      groups: [
        {
          id: "g",
          label: "G",
          description: "D",
          passages: [{ kind: "passage", quote: "tokens", prefix: "A passage about ", suffix: "." }],
        },
      ],
      expectedRevision: 0,
    },
  ],
  // The first comment on an unpinned embedded diagram writes its name into the note: `notes`.
  [
    "notes = false",
    "api/comments",
    { target: "view:UNPINNED", anchor: { kind: "view" }, body: "On the unpinned diagram" },
  ],
  // A refused comment must not have pinned the name first.
  [
    "comments = false",
    "api/comments",
    { target: "view:UNPINNED", anchor: { kind: "view" }, body: "On the unpinned diagram" },
  ],
] as const)(
  "browser %s refuses %s with 403 write_rule_denied and writes nothing",
  async (rule, path, body) => {
    const root = fixture();
    const { admin, post, base } = await browser(root, rule);
    try {
      const views = (JSON.parse((await pageHttp(`${base}api/diagrams`)).body) as { views: { id: string }[] }).views;
      const unpinned = views.find((view) => view.id.startsWith("note.md#") && view.id !== "note.md#pinned")!.id;
      const before = snapshot(root);
      const reply = await post(path, JSON.parse(JSON.stringify(body).replace("UNPINNED", unpinned)));
      expect([reply.status, JSON.parse(reply.body).error?.code], reply.body).toEqual([403, "write_rule_denied"]);
      expect(JSON.parse(reply.body).error.details).toEqual({ rule: rule.split(" ")[0] });
      expect(snapshot(root)).toEqual(before);
    } finally {
      admin.close();
    }
  },
  20_000,
);

test("browser authoring apply and publish are refused under diagrams = false", async () => {
  const root = fixture();
  const { svc, admin, origin } = await browser(root, "diagrams = false");
  try {
    const grant = await admin.call("issueAuthoringAccess", { label: "author", projectRoots: [root] });
    const cookie = ((await pageHttp(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const attached = await admin.call("attach", { root });
    const base = `${origin}/p/${attached.url.split(/\/(?:p|projects)\//u)[1]!.split("/")[0]!}/`;
    const generation = JSON.parse((await pageHttp(`${base}api/authoring`, { headers: { cookie } })).body)
      .generation as string;
    const post = (body: unknown) =>
      pageHttp(`${base}api/authoring`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ journalGeneration: generation, ...(body as object) }),
      });
    const opened = JSON.parse(
      (
        await pageHttp(`${base}api/authoring/open`, {
          method: "POST",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({ target: { kind: "view", viewId: "flow" } }),
        })
      ).body,
    );
    const before = snapshot(root);
    const id = () => randomBytes(16).toString("hex");
    const applied = await post({
      op: "document.apply",
      operationId: id(),
      target: { kind: "view", viewId: "flow" },
      expectedTargetRevision: opened.targetRevision,
      expectedSourceRevision: opened.sourceRevision,
      source: FLOW.replace("Client", "Edited"),
    });
    expect(JSON.parse(applied.body).error).toMatchObject({ code: "write_rule_denied", details: { rule: "diagrams" } });
    expect(applied.status).toBe(403);
    const published = await post({
      op: "document.publish",
      operationId: id(),
      path: "diagrams/fresh.mmd",
      source: FLOW,
    });
    expect([published.status, JSON.parse(published.body).error?.code], published.body).toEqual([
      403,
      "write_rule_denied",
    ]);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, ".archer", "diagrams"))).toBe(false);
    void svc;
  } finally {
    admin.close();
  }
}, 20_000);

// G3 matrix (security round 1, batch 4): a comment sidecar that is a link out of the Archer folder is a
// confinement refusal the caller can read, not a 500, and nothing is written through it.
test("a browser comment on a view whose sidecar is a link out of the folder is refused, not a 500", async () => {
  const root = fixture();
  const outside = join(tempDir("archer-outside-"), "comments.json");
  writeFileSync(outside, "{}");
  symlinkSync(outside, join(root, ".archer", "flow.comments.json"));
  const { admin, post } = await browser(root, "comments = true");
  try {
    const reply = await post("api/comments", { target: "view:flow", anchor: { kind: "view" }, body: "Through a link" });
    expect([reply.status, JSON.parse(reply.body).error?.code], reply.body).toEqual([403, "path_outside_archer_folder"]);
    expect(reply.body).not.toContain(root);
    expect(readFileSync(outside, "utf8")).toBe("{}");
  } finally {
    admin.close();
  }
}, 20_000);

// G3 matrix (security round 1, batch 4): a layout save needs the target's rule as well as `edit` (ADR 0028).
test("a browser layout save is refused under diagrams = false", async () => {
  const root = fixture();
  const { admin, origin } = await browser(root, "diagrams = false");
  try {
    const grant = await admin.call("issueAuthoringAccess", { label: "layout", projectRoots: [root] });
    const cookie = ((await pageHttp(grant.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const attached = await admin.call("attach", { root });
    const base = `${origin}/p/${attached.url.split(/\/(?:p|projects)\//u)[1]!.split("/")[0]!}/api/authoring`;
    const headers = { cookie, origin, "content-type": "application/json" };
    const opened = JSON.parse(
      (
        await pageHttp(`${base}/open`, {
          method: "POST",
          headers,
          body: JSON.stringify({ target: { kind: "view", viewId: "flow" } }),
        })
      ).body,
    );
    const identity = {
      target: opened.target,
      expectedTargetRevision: opened.targetRevision,
      sourceRevision: opened.sourceRevision,
    };
    const saved = await pageHttp(`${base}/presentation`, {
      method: "POST",
      headers,
      body: JSON.stringify({ op: "save", ...identity, expectedRevision: null, positions: { a: { x: 420, y: 130 } } }),
    });
    expect([saved.status, JSON.parse(saved.body).error?.code], saved.body).toEqual([403, "write_rule_denied"]);
    const read = JSON.parse(
      (
        await pageHttp(`${base}/presentation`, {
          method: "POST",
          headers,
          body: JSON.stringify({ op: "read", ...identity }),
        })
      ).body,
    );
    expect(read.presentation ?? null).toBeNull();
  } finally {
    admin.close();
  }
}, 20_000);

test("a configuration that becomes unreadable refuses browser writes with fixed text that names no path", async () => {
  const root = fixture();
  const { admin, post } = await browser(root, "comments = true");
  try {
    const before = snapshot(root);
    const broken = brokenConfigs.at(-1)!;
    broken.break();
    const reply = await post("api/comments", { target: "note:note.md", anchor: { kind: "view" }, body: "Q" });
    expect([reply.status, JSON.parse(reply.body).error?.code]).toEqual([403, "write_rule_denied"]);
    expect(reply.body).not.toContain(broken.path);
    expect(JSON.parse(reply.body).error.message).toBe(
      "Archer could not read your Archer settings; nothing was written.",
    );
    expect(snapshot(root)).toEqual(before);
  } finally {
    admin.close();
  }
}, 20_000);
