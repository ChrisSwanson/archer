// The walkthroughs store on a real temp project (ADR 0034 §1): limits at the
// bound and one past it, refusals that list every issue, malformed files
// reported and left alone, CAS on revision, path naming and its clash, a
// stable byte order, and hosts that cannot have walkthroughs.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import type { DiagramModel } from "../../src/model/index.ts";
import { findProject } from "../../src/project/index.ts";
import { walkthroughsPathFor } from "../../src/notes/embedded.ts";
import { LIMITS, TEXT_LIMITS, type Walkthrough } from "../../src/walkthroughs/contract.ts";
import { groundDraft, readDraft } from "../../src/walkthroughs/ground.ts";
import {
  serializeWalkthroughs,
  validateWalkthroughsFile,
  walkthroughsPlaces,
  WalkthroughsError,
  WalkthroughsStore,
  type WalkthroughsPlace,
} from "../../src/walkthroughs/store.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

// Nine boxes and nine lines, so every per-step bound can be met with distinct ids.
const FLOW =
  "flowchart LR\n  subgraph backend[Backend]\n    b[API]\n    c[DB]\n  end\n  a[Client] e1@-->|asks| b\n  b e2@--> c\n" +
  [3, 4, 5, 6, 7, 8, 9].map((i) => `  n${i}[N${i}] e${i}@--> a\n`).join("");
const BOXES = ["a", "b", "c", "n3", "n4", "n5", "n6", "n7", "n8", "n9"];
const LINES = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"];
const REV = `sha256:${"a".repeat(64)}`;

async function model(source: string): Promise<DiagramModel> {
  const { model, diagnostics } = await compile(source);
  if (model === null) throw new Error(diagnostics.map((d) => d.message).join("; "));
  return model;
}

async function setup() {
  const root = tempDir({
    ".archer/flow.mmd": FLOW,
    ".archer/notes/flow.md": "# Flow\n",
    "src/api.ts": "export function handle() {}\n",
  });
  const project = findProject(root);
  let clock = 0;
  const store = new WalkthroughsStore(project, {
    now: () => new Date(Date.UTC(2026, 9, 23, 9, 0, clock++)).toISOString(),
  });
  const place: WalkthroughsPlace = { viewId: "flow", path: "flow.walkthroughs.json" };
  const graph = await model(FLOW);
  const ctx = { root, noteExists: (path: string) => existsSync(join(project.folder, path)) };
  const ground = (raw: unknown) => {
    const { draft, issues } = readDraft(raw);
    if (draft === null || issues.length > 0) return { ok: false as const, issues };
    return groundDraft(draft, graph, ctx);
  };
  const grounded = (raw: unknown) => {
    const result = ground(raw);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.walkthrough;
  };
  const file = join(project.folder, place.path);
  return { root, project, store, place, graph, ctx, ground, grounded, file };
}

const STEP = {
  title: "Ask",
  kind: "sends",
  what: "A request.",
  nodes: [{ kind: "node", id: "a" }],
  edges: [{ id: "e1" }],
};
const draft = (overrides: Record<string, unknown> = {}) => ({
  id: "ask",
  title: "Asking the API",
  steps: [STEP],
  ...overrides,
});

function refused(run: () => unknown, code: string): WalkthroughsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WalkthroughsError);
    expect((error as WalkthroughsError).code, (error as Error).message).toBe(code);
    return error as WalkthroughsError;
  }
  throw new Error(`expected a ${code} refusal`);
}

describe("paths", () => {
  test("beside a .mmd, and beside the note for an embedded diagram", () => {
    expect(walkthroughsPathFor("diagrams/containers.mmd")).toBe("diagrams/containers.walkthroughs.json");
    expect(walkthroughsPathFor("notes/auth.md", "login")).toBe("notes/auth.login.walkthroughs.json");
  });

  test("two views spelling one sidecar are both refused, like comments_file_conflict", () => {
    const places = walkthroughsPlaces([
      { id: "auth.login", path: "notes/auth.login.mmd" },
      { id: "notes/auth.md#login", path: "notes/auth.md", embedded: { name: "login" } },
      { id: "flow", path: "flow.mmd" },
    ]);
    expect(places.get("flow")).toEqual({ viewId: "flow", path: "flow.walkthroughs.json" });
    expect(places.get("auth.login")?.conflict).toMatch(/notes\/auth\.login\.walkthroughs\.json.*rename/);
    expect(places.get("notes/auth.md#login")?.conflict).toBeDefined();
  });

  test("a conflicting place is refused on read and on write", async () => {
    const { store, grounded } = await setup();
    const place = { viewId: "flow", path: "flow.walkthroughs.json", conflict: "shared" };
    refused(() => store.read(place), "walkthroughs_file_conflict");
    refused(
      () => store.write(place, { walkthrough: grounded(draft()), modelRevision: REV, author: "agent" }),
      "walkthroughs_file_conflict",
    );
  });
});

describe("grounding", () => {
  test("labels and ends come from the model; the caller's are ignored", async () => {
    const { grounded } = await setup();
    const w = grounded(
      draft({
        revision: 9,
        author: "person",
        modelRevision: "sha256:lies",
        commit: "nope",
        writtenAt: "yesterday",
        steps: [
          {
            ...STEP,
            nodes: [{ kind: "node", id: "a", label: "Lies" }],
            edges: [{ id: "e1", source: "x", target: "y", label: "lies" }],
          },
        ],
      }),
    );
    expect(w.steps[0]?.nodes).toEqual([{ kind: "node", id: "a", label: "Client" }]);
    expect(w.steps[0]?.edges).toEqual([{ id: "e1", source: "a", target: "b", label: "asks" }]);
    for (const field of ["revision", "author", "modelRevision", "commit", "writtenAt"])
      expect(w).not.toHaveProperty(field);
  });

  test("an edge anchor is reserved, refused with its own reason", async () => {
    const { ground } = await setup();
    const result = ground(draft({ steps: [{ ...STEP, edges: [{ id: "e1", anchor: "[a,b]#0" }] }] }));
    expect(result.ok ? [] : result.issues).toMatchObject([
      { where: "steps[0].edges[0].anchor", problem: expect.stringMatching(/reserved for sequence hosts/) },
    ]);
  });

  test("a field named like an Object.prototype member is an unknown field, not a malformed issue", async () => {
    const { ground } = await setup();
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const raw = JSON.parse(
        `{"id":"ask","title":"Asking the API","steps":[{"title":"Ask","kind":"sends","what":"A request.","edges":[{"id":"e1"}],${JSON.stringify(key)}:1}]}`,
      );
      const result = ground(raw);
      const issues = result.ok ? [] : result.issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        where: `steps[0].${key}`,
        problem: "is not a field a walkthrough has",
        fix: expect.stringContaining("Use only:"),
      });
    }
  });

  test("a refusal lists every issue, with a Did you mean for near ids", async () => {
    const { ground } = await setup();
    const result = ground(
      draft({
        id: "Bad Id",
        title: "x".repeat(TEXT_LIMITS.title.chars + 1),
        steps: [
          { ...STEP, nodes: [{ kind: "node", id: "clinet" }], edges: [{ id: "e9" }] },
          { title: "Nothing", kind: "goes", what: "", nodes: [], edges: [], code: ["src/missing.ts"] },
          { ...STEP, nodes: [{ kind: "node", id: "backend" }], messages: [{ from: "a", to: "nowhere", label: "Hi" }] },
        ],
        open: ["b"],
        note: "notes/missing.md",
        deeper: { viewId: "x" },
        colour: "teal",
      }),
    );
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues;
    const said = issues.map((i) => `${i.where}: ${i.problem} | ${i.fix}`).join("\n");
    for (const expected of [
      /^id: /m,
      /^title: .*characters/m,
      /deeper.*not supported/,
      /colour/,
      /steps\[1\]\.kind/,
      /steps\[1\]\.what.*empty/,
      /steps\[1\].*names no element/,
    ])
      expect(said).toMatch(expected);
    // Shape problems first: an unreadable draft is not grounded, so ids are checked on a readable one.
    const shaped = ground(
      draft({
        steps: [
          { ...STEP, nodes: [{ kind: "node", id: "nn3" }], edges: [{ id: "e99" }] },
          { ...STEP, code: ["src/missing.ts", "src/api.ts#handle", "src/api.ts#nothing"] },
          { ...STEP, nodes: [{ kind: "node", id: "backend" }], messages: [{ from: "a", to: "nowhere", label: "Hi" }] },
        ],
        open: ["b"],
        note: "notes/missing.md",
      }),
    );
    const grounding = (shaped.ok ? [] : shaped.issues).map((i) => `${i.where}: ${i.problem} | ${i.fix}`).join("\n");
    for (const expected of [
      /steps\[0\]\.nodes\[0\]: no node "nn3".*Did you mean "n3"\?/,
      /steps\[0\]\.edges\[0\]: no edge "e99".*Did you mean "e9"\?/,
      /steps\[1\]\.code\[0\]: "src\/missing\.ts" does not exist/,
      /steps\[1\]\.code\[2\]: .*has no nothing/,
      /steps\[2\]\.nodes\[0\]: .*group.*kind: "group"/,
      /steps\[2\]\.messages\[0\]: .*"nowhere"/,
      /open\[0\]: "b" is not a container/,
      /note: .*notes\/missing\.md/,
    ])
      expect(grounding).toMatch(expected);
    expect(grounding).not.toMatch(/code\[1\]/);
  });

  test("sequence and journey hosts are refused", async () => {
    const { ctx } = await setup();
    for (const source of [
      "sequenceDiagram\n  participant a as A\n  participant b as B\n  a->>b: hi\n",
      "journey\n  title T\n  section S\n    Do it: 5: Me\n",
    ]) {
      const { draft: d } = readDraft(draft({ steps: [{ ...STEP, edges: [] }] }));
      const result = groundDraft(d!, await model(source), ctx);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.issues[0]?.problem).toMatch(/walkthroughs are on graph diagrams/);
    }
  });
});

describe("limits, at the bound and one past", () => {
  const cases: [string, (n: number) => Record<string, unknown>, number][] = [
    ["steps", (n) => draft({ steps: Array.from({ length: n }, () => STEP) }), LIMITS.steps],
    [
      "nodes",
      (n) => draft({ steps: [{ ...STEP, nodes: BOXES.slice(0, n).map((id) => ({ kind: "node", id })) }] }),
      LIMITS.nodes,
    ],
    ["edges", (n) => draft({ steps: [{ ...STEP, edges: LINES.slice(0, n).map((id) => ({ id })) }] }), LIMITS.edges],
    [
      "messages",
      (n) =>
        draft({
          steps: [{ ...STEP, messages: Array.from({ length: n }, () => ({ from: "a", to: "b", label: "hi" })) }],
        }),
      LIMITS.messages,
    ],
    ["code", (n) => draft({ steps: [{ ...STEP, code: Array.from({ length: n }, () => "src/api.ts") }] }), LIMITS.code],
    ["title", (n) => draft({ title: "x".repeat(n) }), TEXT_LIMITS.title.chars],
    ["title words", (n) => draft({ title: Array.from({ length: n }, () => "w").join(" ") }), TEXT_LIMITS.title.words],
    ["description", (n) => draft({ description: "x".repeat(n) }), TEXT_LIMITS.description.chars],
    ["step title", (n) => draft({ steps: [{ ...STEP, title: "x".repeat(n) }] }), TEXT_LIMITS.stepTitle.chars],
    ["what", (n) => draft({ steps: [{ ...STEP, what: "😀".repeat(n) }] }), TEXT_LIMITS.what.chars],
    ["why", (n) => draft({ steps: [{ ...STEP, why: "x".repeat(n) }] }), TEXT_LIMITS.why.chars],
    [
      "message label",
      (n) => draft({ steps: [{ ...STEP, messages: [{ from: "a", to: "b", label: "x".repeat(n) }] }] }),
      TEXT_LIMITS.messageLabel.chars,
    ],
    ["id", (n) => draft({ id: "a".repeat(n) }), 48],
  ];
  test.each(cases)("%s", async (_name, make, bound) => {
    const { ground } = await setup();
    const at = ground(make(bound));
    expect(at.ok, JSON.stringify(at.ok ? null : at.issues)).toBe(true);
    const past = ground(make(bound + 1));
    expect(past.ok).toBe(false);
  });

  test(`${LIMITS.walkthroughs} walkthroughs per diagram`, async () => {
    const { store, place, grounded } = await setup();
    for (let i = 0; i < LIMITS.walkthroughs; i++)
      store.write(place, { walkthrough: grounded(draft({ id: `w${i}` })), modelRevision: REV, author: "agent" });
    const error = refused(
      () =>
        store.write(place, { walkthrough: grounded(draft({ id: "one-more" })), modelRevision: REV, author: "agent" }),
      "invalid_walkthrough",
    );
    expect(error.message).toMatch(/12/);
    expect(store.read(place).walkthroughs).toHaveLength(LIMITS.walkthroughs);
  });

  test("a file over 256 KiB is refused, and the file stays as it was", async () => {
    const { store, place, file, ctx } = await setup();
    // Labels come from the model, so long box labels make a big file within every text bound.
    const long = await model(
      `flowchart LR\n${Array.from({ length: 8 }, (_, i) => `  b${i}["${"😀".repeat(200)}${i}"]\n`).join("")}`,
    );
    const big = (id: string) => {
      const { draft: d } = readDraft(
        draft({
          id,
          steps: Array.from({ length: LIMITS.steps }, () => ({
            ...STEP,
            edges: [],
            nodes: Array.from({ length: 8 }, (_, i) => ({ kind: "node", id: `b${i}` })),
          })),
        }),
      );
      const result = groundDraft(d!, long, ctx);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return result.walkthrough;
    };
    store.write(place, { walkthrough: big("first"), modelRevision: REV, author: "agent" });
    const before = readFileSync(file, "utf8");
    expect(Buffer.byteLength(before)).toBeLessThanOrEqual(LIMITS.fileBytes);
    const error = refused(
      () => store.write(place, { walkthrough: big("second"), modelRevision: REV, author: "agent" }),
      "invalid_walkthrough",
    );
    expect(error.message).toMatch(/262144/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("writes", () => {
  test("create, replace with the revision, a stale revision refused with the walkthrough as it is, delete", async () => {
    const { store, place, file, grounded } = await setup();
    const created = store.write(place, { walkthrough: grounded(draft()), modelRevision: REV, author: "agent" });
    expect(created).toMatchObject({
      id: "ask",
      revision: 1,
      modelRevision: REV,
      author: "agent",
      writtenAt: "2026-10-23T09:00:00.000Z",
    });
    refused(
      () => store.write(place, { walkthrough: grounded(draft()), modelRevision: REV, author: "agent" }),
      "walkthrough_changed",
    );
    const replaced = store.write(place, {
      walkthrough: grounded(draft({ title: "Asking again" })),
      modelRevision: REV,
      author: "person",
      expectedRevision: 1,
    });
    expect(replaced).toMatchObject({ revision: 2, title: "Asking again", author: "person" });
    const stale = refused(
      () =>
        store.write(place, {
          walkthrough: grounded(draft({ title: "Late" })),
          modelRevision: REV,
          author: "agent",
          expectedRevision: 1,
        }),
      "walkthrough_changed",
    );
    expect(stale.details).toMatchObject({ walkthrough: { id: "ask", revision: 2, title: "Asking again" } });
    refused(
      () =>
        store.write(place, {
          walkthrough: grounded(draft({ id: "other" })),
          modelRevision: REV,
          author: "agent",
          expectedRevision: 1,
        }),
      "invalid_walkthrough",
    );
    refused(() => store.remove(place, "ask", 1), "walkthrough_changed");
    refused(() => store.remove(place, "nope", 1), "invalid_walkthrough");
    store.remove(place, "ask", 2);
    expect(existsSync(file)).toBe(false);
  });

  test("stable key order: a parsed file serializes to its own bytes, and writing the same walkthrough again changes nothing", async () => {
    const { store, place, file, grounded } = await setup();
    store.write(place, {
      walkthrough: grounded(
        draft({
          description: "How the client asks.",
          open: ["backend"],
          note: "notes/flow.md",
          steps: [
            { ...STEP, why: "Because.", code: ["src/api.ts"], messages: [{ from: "a", to: "b", label: "GET /" }] },
          ],
        }),
      ),
      modelRevision: REV,
      author: "agent",
      commit: "c".repeat(40),
    });
    const bytes = readFileSync(file, "utf8");
    const parsed = validateWalkthroughsFile(JSON.parse(bytes));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? serializeWalkthroughs(parsed.file) : "").toBe(bytes);
    expect(Object.keys(JSON.parse(bytes).walkthroughs[0])).toEqual([
      "id",
      "title",
      "description",
      "revision",
      "modelRevision",
      "commit",
      "author",
      "writtenAt",
      "note",
      "open",
      "steps",
    ]);
    const again = store.write(place, {
      walkthrough: grounded(
        draft({
          description: "How the client asks.",
          open: ["backend"],
          note: "notes/flow.md",
          steps: [
            { ...STEP, why: "Because.", code: ["src/api.ts"], messages: [{ from: "a", to: "b", label: "GET /" }] },
          ],
        }),
      ),
      modelRevision: REV,
      author: "agent",
      expectedRevision: 1,
      commit: "c".repeat(40),
    });
    expect(again.revision).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  test("a same-content rewrite keeps a valid commit; a newer commit for the same model changes nothing; a new model may record one", async () => {
    const { store, place, file, grounded } = await setup();
    const write = (extra: Record<string, unknown>) =>
      store.write(place, { walkthrough: grounded(draft()), modelRevision: REV, author: "agent", ...extra });
    write({ commit: "c".repeat(40) });
    const bytes = readFileSync(file, "utf8");
    // No commit found this time (HEAD moved on, or Git is away): the recorded one stands, nothing is written.
    expect(write({ expectedRevision: 1 }).commit).toBe("c".repeat(40));
    expect(readFileSync(file, "utf8")).toBe(bytes);
    // A later commit that also holds the model is no reason to rewrite.
    expect(write({ expectedRevision: 1, commit: "d".repeat(40) }).revision).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    // Changed text against the same model keeps the commit that vouches for it.
    const changed = store.write(place, {
      walkthrough: grounded(draft({ title: "Asking again" })),
      modelRevision: REV,
      author: "agent",
      expectedRevision: 1,
    });
    expect(changed).toMatchObject({ revision: 2, commit: "c".repeat(40) });
    // A different model revision does not inherit it.
    const next = store.write(place, {
      walkthrough: grounded(draft({ title: "Asking again" })),
      modelRevision: `sha256:${"b".repeat(64)}`,
      author: "agent",
      expectedRevision: 2,
    });
    expect(next.commit).toBeUndefined();
  });

  test("a malformed file is reported and never rewritten", async () => {
    const { store, place, file, grounded } = await setup();
    for (const text of [
      "{ broken",
      JSON.stringify({ schemaVersion: 2, target: "view:flow", walkthroughs: [] }),
      JSON.stringify({ schemaVersion: 1, target: "view:flow", walkthroughs: [{ id: "x" }] }),
    ]) {
      writeFileSync(file, text);
      const error = refused(() => store.read(place), "malformed_walkthroughs_file");
      expect(error.message).toMatch(/flow\.walkthroughs\.json/);
      refused(
        () => store.write(place, { walkthrough: grounded(draft()), modelRevision: REV, author: "agent" }),
        "malformed_walkthroughs_file",
      );
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });

  test("a same-content write leaves a valid but hand-formatted file byte for byte", async () => {
    const { store, place, file, grounded } = await setup();
    store.write(place, { walkthrough: grounded(draft()), modelRevision: REV, author: "agent" });
    const handmade = JSON.stringify(JSON.parse(readFileSync(file, "utf8"))).replace(/\n/g, "\r\n");
    writeFileSync(file, handmade);
    expect(
      store.write(place, { walkthrough: grounded(draft()), modelRevision: REV, author: "agent", expectedRevision: 1 })
        .revision,
    ).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(handmade);
  });

  test("a link or a directory in the sidecar's place is reported, never followed or replaced", async () => {
    const { store, place, file, project, grounded } = await setup();
    writeFileSync(
      join(project.folder, "elsewhere.json"),
      JSON.stringify({ schemaVersion: 1, target: "view:flow", walkthroughs: [] }),
    );
    symlinkSync("elsewhere.json", file);
    expect(refused(() => store.read(place), "malformed_walkthroughs_file").message).toMatch(/not a plain file/);
    refused(
      () => store.write(place, { walkthrough: grounded(draft()), modelRevision: REV, author: "agent" }),
      "malformed_walkthroughs_file",
    );
    const other = { viewId: "other", path: "other.walkthroughs.json" };
    mkdirSync(join(project.folder, other.path));
    refused(() => store.read(other), "malformed_walkthroughs_file");
  });

  test("a file over 256 KiB on disk is reported, not read", async () => {
    const { store, place, file } = await setup();
    writeFileSync(file, " ".repeat(LIMITS.fileBytes + 1));
    expect(refused(() => store.read(place), "malformed_walkthroughs_file").message).toMatch(/over 262144 bytes/);
  });

  test("a missing file reads as none, and a file with another view's target is this view's", async () => {
    const { store, place, file, grounded } = await setup();
    expect(store.read(place)).toEqual({ schemaVersion: 1, target: "view:flow", walkthroughs: [] });
    store.write(place, { walkthrough: grounded(draft()), modelRevision: REV, author: "agent" });
    const text = readFileSync(file, "utf8").replace('"view:flow"', '"view:old-name"');
    writeFileSync(file, text);
    expect(store.read(place).target).toBe("view:flow");
  });

  test("validates the stored shape: labels are required on disk", () => {
    const stored: Walkthrough = {
      id: "w",
      title: "W",
      revision: 1,
      modelRevision: REV,
      author: "agent",
      writtenAt: "2026-10-23T09:00:00Z",
      steps: [{ id: "s", title: "S", kind: "does", what: "x", nodes: [{ kind: "node", id: "a", label: "A" }] }],
    };
    expect(validateWalkthroughsFile({ schemaVersion: 1, target: "view:flow", walkthroughs: [stored] }).ok).toBe(true);
    const unlabelled = { ...stored, steps: [{ ...stored.steps[0], nodes: [{ kind: "node", id: "a" }] }] };
    expect(validateWalkthroughsFile({ schemaVersion: 1, target: "view:flow", walkthroughs: [unlabelled] }).ok).toBe(
      false,
    );
    expect(
      validateWalkthroughsFile({ schemaVersion: 1, target: "view:flow", walkthroughs: [stored, stored] }),
    ).toMatchObject({ ok: false });
  });
});
