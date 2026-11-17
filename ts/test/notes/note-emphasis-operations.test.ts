import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { createApplication, OperationError, OPERATIONS } from "../../src/application/index.ts";
import { NoteEmphasisStore } from "../../src/notes/emphasis.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

const passage = {
  kind: "passage" as const,
  quote: "signed token",
  prefix: "The client sends a ",
  suffix: " to the API.",
};
const groups = [{ id: "token", label: "Token exchange", description: "Trust boundary", passages: [passage] }];

test("application note-emphasis operations read and write the production store as the agent under CAS", async () => {
  const source = "# Login\n\nThe client sends a signed token to the API.\n";
  const root = tempDir({ ".archer/notes/auth.md": source });
  const app = createApplication({ cwd: root });
  try {
    expect(OPERATIONS.map((operation) => operation.name)).toEqual(
      expect.arrayContaining(["list_note_emphases", "set_note_emphasis"]),
    );
    expect(await app.call("list_note_emphases", { notePath: "notes/auth.md" })).toMatchObject({
      structured: { snapshot: { schemaVersion: 1, notePath: "notes/auth.md", revision: 0, emphases: [] }, orphans: [] },
    });

    const written = await app.call("set_note_emphasis", {
      notePath: "notes/auth.md",
      id: "auth",
      title: "Authentication",
      groups,
      expectedRevision: 0,
    });
    expect(written).toMatchObject({
      structured: {
        snapshot: {
          schemaVersion: 1,
          notePath: "notes/auth.md",
          revision: 1,
          emphases: [{ id: "auth", title: "Authentication", author: "agent", groups }],
        },
        orphans: [],
      },
    });
    expect(new NoteEmphasisStore(findProject(root)).read("notes/auth.md")).toEqual(written.structured);
    expect(readFileSync(`${root}/.archer/notes/auth.md`, "utf8")).toBe(source);

    await expect(
      app.call("set_note_emphasis", { notePath: "notes/auth.md", id: "auth", groups: [], expectedRevision: 0 }),
    ).rejects.toMatchObject({
      constructor: OperationError,
      data: { code: "note_emphasis_conflict", actualSnapshot: { revision: 1, emphases: [{ author: "agent" }] } },
    });
    expect((await app.call("list_note_emphases", { notePath: "notes/auth.md" })).structured).toEqual(
      written.structured,
    );
  } finally {
    app.close();
  }
});

test("operation validation cannot spoof the author and refusals preserve the prior production state", async () => {
  const source = "The client sends a signed token to the API.";
  const root = tempDir({ ".archer/note.md": source });
  const store = new NoteEmphasisStore(findProject(root));
  store.upsert({ notePath: "note.md", id: "person-review", groups, expectedRevision: 0 }, "person");
  const app = createApplication({ cwd: root });
  try {
    expect((await app.call("list_note_emphases", { notePath: "note.md" })).structured).toMatchObject({
      snapshot: { revision: 1, emphases: [{ id: "person-review", author: "person" }] },
    });

    await expect(
      app.call("set_note_emphasis", {
        notePath: "note.md",
        id: "spoof",
        author: "person",
        groups: [],
        expectedRevision: 1,
        // set_note_emphasis has its own parser (so a withdrawn `palette` gets its fix); it names the field.
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('"author"'), data: { code: "invalid_note_emphasis" } });

    const agent = await app.call("set_note_emphasis", {
      notePath: "note.md",
      id: "agent-review",
      groups,
      expectedRevision: 1,
      outputFormat: "text",
    });
    expect(agent.text).toContain("as agent");
    expect(agent.text).toContain("snapshot");
    expect(agent.structured).toMatchObject({
      snapshot: {
        revision: 2,
        emphases: [
          { id: "person-review", author: "person" },
          { id: "agent-review", author: "agent" },
        ],
      },
    });
    const before = store.read("note.md");

    for (const [args, code] of [
      [{ notePath: "missing.md", id: "x", groups: [], expectedRevision: 0 }, "note_not_found"],
      [{ notePath: "../note.md", id: "x", groups: [], expectedRevision: 0 }, "note_not_found"],
      [
        { notePath: "note.md", id: "duplicate", groups: [groups[0], groups[0]], expectedRevision: 2 },
        "invalid_note_emphasis",
      ],
      [
        {
          notePath: "note.md",
          id: "missing-passage",
          expectedRevision: 2,
          groups: [{ ...groups[0], passages: [{ kind: "passage", quote: "not present", prefix: "", suffix: "" }] }],
        },
        "invalid_note_emphasis",
      ],
    ] as const) {
      await expect(app.call("set_note_emphasis", args)).rejects.toMatchObject({ data: { code } });
      expect(store.read("note.md"), code).toEqual(before);
    }
  } finally {
    app.close();
  }
});

test("operation reads report corrupt state under its stable code with no rewrite", async () => {
  const root = tempDir({ ".archer/note.md": "Text", ".archer/note.md.emphases.json": "{broken" });
  const app = createApplication({ cwd: root });
  try {
    await expect(app.call("list_note_emphases", { notePath: "note.md" })).rejects.toMatchObject({
      data: { code: "malformed_note_emphasis_file" },
    });
    expect(readFileSync(`${root}/.archer/note.md.emphases.json`, "utf8")).toBe("{broken");
  } finally {
    app.close();
  }
});
