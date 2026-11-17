// What read_diagram and validate_diagram say about a note an agent has just written: its
// diagram's name is pinned (`%% archer-id:` first inside the fence) and its front matter has
// `author: agent` and `description:`. Small agents missed both in the evals
// (docs/evaluations/eval-baseline.md); the tools now name the fix. The person's committed notes
// get no such advice: agents must not restructure them.
import { afterEach, describe, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { renderOperation } from "../../src/application/render.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";
import { cleanup, commit, repo, write } from "../accuracy/support.ts";

afterEach(cleanup);
afterEach(removeTempDirs);

const note = (front: string, fence: string) =>
  `---\n${front}---\n\n# Password reset\n\n\`\`\`mermaid\n${fence}\`\`\`\n`;
const BODY = 'flowchart LR\n  a["A"] e1@--> b["B"]\n';
const ADDRESS = "notes/reset.md#password-reset";

/** A repository with one commit, and the note written after it (never committed). */
function newNote(text: string) {
  const root = repo({ "README.md": "x\n" });
  commit(root);
  write(root, ".archer/notes/reset.md", text);
  return createApplication({ cwd: root });
}

const authoring = (structured: unknown) => (structured as { authoring?: string[] }).authoring ?? [];

describe("a new note's authoring check", () => {
  test("an unpinned diagram: read_diagram names the archer-id line to add, first inside the fence", async () => {
    const app = newNote(note("author: agent\ndescription: How a reset works.\n", BODY));
    try {
      const read = await app.call("read_diagram", { viewId: ADDRESS });
      expect(authoring(read.structured)).toEqual([
        expect.stringContaining("`%% archer-id: password-reset` as the first line inside the fence"),
      ]);
      expect(read.text).toContain("%% archer-id: password-reset");
      expect(renderOperation("read_diagram", read)).toContain("%% archer-id: password-reset");
    } finally {
      app.close();
    }
  });

  test("an archer-id after the header is not read: it says to move it", async () => {
    const app = newNote(
      note(
        "author: agent\ndescription: How a reset works.\n",
        'flowchart LR\n  %% archer-id: reset-flow\n  a["A"] e1@--> b["B"]\n',
      ),
    );
    try {
      const read = await app.call("read_diagram", { viewId: ADDRESS });
      expect(authoring(read.structured).join(" ")).toMatch(
        /after the Mermaid header.*move it to the first line inside the fence/,
      );
      // Moving it renames the diagram to the marker's name: the address to read next.
      expect(authoring(read.structured).join(" ")).toContain("notes/reset.md#reset-flow");
    } finally {
      app.close();
    }
  });

  test("a new note without author: agent or description: says to add them, if the agent wrote it", async () => {
    const app = newNote(note("type: decision\n", `%% archer-id: password-reset\n${BODY}`));
    try {
      const read = await app.call("read_diagram", { viewId: ADDRESS });
      const said = authoring(read.structured).join(" ");
      expect(said).toContain("author: agent");
      expect(said).toContain("description:");
      expect(said).toMatch(/if you wrote this new note/i);
      const checked = await app.call("validate_diagram", {
        viewId: ADDRESS,
        source: `%% archer-id: password-reset\n${BODY}`,
      });
      expect(authoring(checked.structured).join(" ")).toContain("author: agent");
      expect(renderOperation("validate_diagram", checked)).toContain("author: agent");
    } finally {
      app.close();
    }
  });

  test("validate_diagram checks the pin in the source it is given", async () => {
    const app = newNote(
      note("author: agent\ndescription: How a reset works.\n", `%% archer-id: password-reset\n${BODY}`),
    );
    try {
      expect(authoring((await app.call("validate_diagram", { viewId: ADDRESS, source: BODY })).structured)).toEqual([]);
      const unpinnedFile = newNote(note("author: agent\ndescription: How a reset works.\n", BODY));
      try {
        // The file is unpinned, but a write of a pinned source fixes it: nothing to say.
        expect(
          authoring(
            (
              await unpinnedFile.call("validate_diagram", {
                viewId: ADDRESS,
                source: `%% archer-id: password-reset\n${BODY}`,
              })
            ).structured,
          ),
        ).toEqual([]);
        expect(
          authoring((await unpinnedFile.call("validate_diagram", { viewId: ADDRESS, source: BODY })).structured),
        ).toEqual([expect.stringContaining("%% archer-id: password-reset")]);
      } finally {
        unpinnedFile.close();
      }
    } finally {
      app.close();
    }
  });

  test("a complete new note, and the person's committed note, get no advice", async () => {
    const done = newNote(
      note("author: agent\ndescription: How a reset works.\n", `%% archer-id: password-reset\n${BODY}`),
    );
    try {
      const read = await done.call("read_diagram", { viewId: ADDRESS });
      expect(read.structured).not.toHaveProperty("authoring");
      expect(read.text).not.toContain("archer-id");
    } finally {
      done.close();
    }
    const root = repo({ ".archer/notes/reset.md": note("type: decision\n", BODY) });
    commit(root);
    const person = createApplication({ cwd: root });
    try {
      expect(authoring((await person.call("read_diagram", { viewId: ADDRESS })).structured)).toEqual([]);
    } finally {
      person.close();
    }
  });

  test("outside Git only the agent's own note (author: agent) is advised", async () => {
    const root = tempDir({ ".archer/notes/reset.md": note("type: decision\n", BODY) });
    const app = createApplication({ cwd: root });
    try {
      expect(authoring((await app.call("read_diagram", { viewId: ADDRESS })).structured)).toEqual([]);
    } finally {
      app.close();
    }
    const own = tempDir({ ".archer/notes/reset.md": note("author: agent\n", BODY) });
    const ownApp = createApplication({ cwd: own });
    try {
      const said = authoring((await ownApp.call("read_diagram", { viewId: ADDRESS })).structured).join(" ");
      expect(said).toContain("%% archer-id: password-reset");
      expect(said).toContain("description:");
    } finally {
      ownApp.close();
    }
  });
});

// Codex review of the check.
describe("a new note's authoring check, adversarially", () => {
  test("in a new note without author: agent every repair is conditional on having written it", async () => {
    const app = newNote(note("type: decision\n", BODY));
    try {
      const said = authoring((await app.call("read_diagram", { viewId: ADDRESS })).structured);
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/^If you wrote this new note,/);
      expect(said[0]).toContain("%% archer-id: password-reset");
      expect(said[0]).toContain("author: agent");
    } finally {
      app.close();
    }
  });

  test("a marker Archer does not take as a name is no pin", async () => {
    const app = newNote(note("author: agent\ndescription: How a reset works.\n", `%% archer-id: not a name\n${BODY}`));
    try {
      expect(authoring((await app.call("read_diagram", { viewId: ADDRESS })).structured).join(" ")).toContain(
        "%% archer-id: password-reset",
      );
      expect(
        authoring(
          (await app.call("validate_diagram", { viewId: ADDRESS, source: `%% archer-id: not a name\n${BODY}` }))
            .structured,
        ).join(" "),
      ).toContain("%% archer-id: password-reset");
    } finally {
      app.close();
    }
  });
});
