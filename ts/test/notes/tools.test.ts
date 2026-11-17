// Slice D: read_diagram, validate_diagram and write_diagram take an embedded
// diagram's note-scoped address. A write replaces only that fence's body, at
// the body's revision, so prose edits around it never conflict.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createApplication, OperationError } from "../../src/application/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

const NOTE = [
  "---",
  "type: decision",
  "---",
  "# Auth",
  "",
  "## Login flow",
  "",
  "```mermaid",
  "flowchart LR",
  '  user["User"] e1@--> api["API"]',
  "```",
  "",
  "Prose after the first diagram.",
  "",
  "## Tokens",
  "",
  "```mermaid",
  "%% archer-id: refresh",
  "flowchart TB",
  '  old["Old"] r1@--> new["New"]',
  "```",
  "",
  "- nested:",
  "",
  "  ```mermaid",
  "  flowchart LR",
  '    x["X"]',
  "  ```",
  "",
].join("\n");

const LOGIN = "notes/auth.md#login-flow";

function setUp(text = NOTE) {
  const root = tempDir({ ".archer/notes/auth.md": text });
  const app = createApplication({ cwd: root });
  const file = join(root, ".archer/notes/auth.md");
  return { app, root, file, note: () => readFileSync(file, "utf8") };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return { code: String((error as OperationError).data.code), message: (error as Error).message };
  }
  throw new Error("expected a refusal");
}

describe("read_diagram by address", () => {
  test("returns the fence's source, its body revision, the model and the note's freshness", async () => {
    const { app } = setUp();
    try {
      const read = await app.call("read_diagram", { viewId: LOGIN });
      expect(read.structured).toMatchObject({
        view: {
          id: LOGIN,
          address: LOGIN,
          note: "notes/auth.md",
          name: "login-flow",
          kind: "freeform",
          registration: "embedded",
          writable: true,
          line: 8,
        },
        sourceRevision: expect.stringMatching(/^sha256:/),
        envelope: { view: { id: LOGIN }, model: { type: "freeform-graph" } },
        source: {
          status: "text",
          text: 'flowchart LR\n  user["User"] e1@--> api["API"]\n',
          path: ".archer/notes/auth.md",
          line: 8,
          bodyLine: 9,
        },
        compile: { status: "compiled", diagnostics: [] },
        freshness: { status: "not-in-git" },
      });
      expect(read.text).toContain("notes/auth.md line 8");
      expect(read.text).toContain("Not in Git");
    } finally {
      app.close();
    }
  });

  test("an address that names no diagram, and a viewId that is neither, are refused as before", async () => {
    const { app } = setUp();
    try {
      expect((await refusal(app.call("read_diagram", { viewId: "notes/auth.md#nope" }))).code).toBe(
        "diagram_not_found",
      );
      expect((await refusal(app.call("read_diagram", { viewId: "../x.md#a" }))).code).toBe("invalid_arguments");
      expect((await refusal(app.call("read_diagram", { viewId: "not an id" }))).code).toBe("invalid_arguments");
    } finally {
      app.close();
    }
  });
});

describe("write_diagram by address", () => {
  test("replaces only that fence's body, pins its name, and keeps everything else byte for byte", async () => {
    const { app, note } = setUp();
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: LOGIN })).structured as {
        sourceRevision: string;
      };
      const next = 'flowchart LR\n  user["User"] e1@--> api["API"]\n  api e2@--> db[("DB")]\n';
      const wrote = await app.call("write_diagram", { viewId: LOGIN, source: next, expectedRevision: sourceRevision });
      expect(wrote.structured).toMatchObject({ status: "compiled", address: LOGIN, diagnostics: [] });
      const expected = NOTE.replace(
        '```mermaid\nflowchart LR\n  user["User"] e1@--> api["API"]\n```',
        "```mermaid\n%% archer-id: login-flow\n" + next + "```",
      );
      expect(note()).toBe(expected);
      const again = (await app.call("read_diagram", { viewId: LOGIN })).structured as {
        sourceRevision: string;
        view: { explicit: boolean };
      };
      expect(again.sourceRevision).toBe((wrote.structured as { sourceRevision: string }).sourceRevision);
      expect(again.view.explicit).toBe(true);
    } finally {
      app.close();
    }
  });

  test("an edit to the prose around it since it was read is no conflict", async () => {
    const { app, file, note } = setUp();
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: LOGIN })).structured as {
        sourceRevision: string;
      };
      writeFileSync(
        file,
        NOTE.replace(
          "Prose after the first diagram.",
          "Prose after the first diagram, edited.\n\nAnd a new paragraph.",
        ),
      );
      await app.call("write_diagram", {
        viewId: LOGIN,
        source: 'flowchart LR\n  a["A"]\n',
        expectedRevision: sourceRevision,
      });
      expect(note()).toContain("And a new paragraph.");
      expect(note()).toContain('%% archer-id: login-flow\nflowchart LR\n  a["A"]\n```');
    } finally {
      app.close();
    }
  });

  test("an edit to the fence since it was read is a conflict, and nothing is written", async () => {
    const { app, file, note } = setUp();
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: LOGIN })).structured as {
        sourceRevision: string;
      };
      const edited = NOTE.replace('user["User"]', 'user["Person"]');
      writeFileSync(file, edited);
      const refused = await refusal(
        app.call("write_diagram", { viewId: LOGIN, source: "flowchart LR\n", expectedRevision: sourceRevision }),
      );
      expect(refused.code).toBe("revision_conflict");
      expect(note()).toBe(edited);
    } finally {
      app.close();
    }
  });

  test("keeps the note's CRLF line endings", async () => {
    const { app, note } = setUp(NOTE.replace(/\n/g, "\r\n"));
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: "notes/auth.md#refresh" })).structured as {
        sourceRevision: string;
      };
      await app.call("write_diagram", {
        viewId: "notes/auth.md#refresh",
        source: '%% archer-id: refresh\nflowchart TB\n  old["Old"]\n',
        expectedRevision: sourceRevision,
      });
      expect(note()).not.toMatch(/[^\r]\n/);
      expect(note()).toContain('%% archer-id: refresh\r\nflowchart TB\r\n  old["Old"]\r\n```');
    } finally {
      app.close();
    }
  });

  test("refuses a nested fence, and says why", async () => {
    const { app, note } = setUp();
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: "notes/auth.md#tokens" })).structured as {
        sourceRevision: string;
      };
      const refused = await refusal(
        app.call("write_diagram", {
          viewId: "notes/auth.md#tokens",
          source: "flowchart LR\n",
          expectedRevision: sourceRevision,
        }),
      );
      expect(refused).toMatchObject({ code: "invalid_request", message: expect.stringContaining("nested") });
      expect(note()).toBe(NOTE);
    } finally {
      app.close();
    }
  });

  test("writes a source that does not compile, and reports its problems at lines of the note", async () => {
    const { app } = setUp();
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: LOGIN })).structured as {
        sourceRevision: string;
      };
      const wrote = await app.call("write_diagram", {
        viewId: LOGIN,
        source: "flowchart LR\n  a[A] --> b[B]\n",
        expectedRevision: sourceRevision,
      });
      const structured = wrote.structured as { status: string; diagnostics: { span: { start: { line: number } } }[] };
      expect(structured.status).toBe("failed");
      // Line 8 is the fence, 9 the pinned id line, 10 the header, 11 the edge.
      expect(structured.diagnostics.map((d) => d.span.start.line)).toContain(11);
    } finally {
      app.close();
    }
  });
});

test("validate_diagram by address reports problems where they would be in the note", async () => {
  const { app, note } = setUp();
  try {
    const checked = await app.call("validate_diagram", { viewId: LOGIN, source: "flowchart LR\n  a[A] --> b[B]\n" });
    const structured = checked.structured as { valid: boolean; diagnostics: { span: { start: { line: number } } }[] };
    expect(structured.valid).toBe(false);
    expect(structured.diagnostics.map((d) => d.span.start.line)).toContain(11);
    expect(
      (await app.call("validate_diagram", { viewId: LOGIN, source: 'flowchart LR\n  a["A"]\n' })).structured,
    ).toMatchObject({ valid: true });
    expect(note()).toBe(NOTE);
  } finally {
    app.close();
  }
});

test("the readable output names the embedded diagrams and the note's freshness", async () => {
  const { renderOperation } = await import("../../src/application/render.ts");
  const { app } = setUp();
  try {
    expect(renderOperation("list_diagrams", await app.call("list_diagrams", {}))).toContain(
      'embedded address="notes/auth.md#login-flow"',
    );
    expect(renderOperation("read_diagram", await app.call("read_diagram", { viewId: LOGIN }))).toContain(
      'freshness status="not-in-git"',
    );
  } finally {
    app.close();
  }
});

// From a Codex review of the note tools.
describe("write_diagram by address, adversarially", () => {
  test("a stale derived address does not write the identical diagram that took its name", async () => {
    const twin = '# Login\n\n```mermaid\nflowchart LR\n  a["A"]\n```\n';
    const { app, file, note } = setUp(twin);
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: "notes/auth.md#login" })).structured as {
        sourceRevision: string;
      };
      // An identical fence inserted before it takes the name `login`; the one read is now `login-2`.
      const moved = twin.replace("# Login\n", '# Login\n\n```mermaid\nflowchart LR\n  a["A"]\n```\n');
      writeFileSync(file, moved);
      expect(
        (
          await refusal(
            app.call("write_diagram", {
              viewId: "notes/auth.md#login",
              source: "flowchart TB\n",
              expectedRevision: sourceRevision,
            }),
          )
        ).code,
      ).toBe("revision_conflict");
      expect(note()).toBe(moved);
    } finally {
      app.close();
    }
  });

  test("a pinned diagram keeps its revision when fences are added before it", async () => {
    const { app, file } = setUp();
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: "notes/auth.md#refresh" })).structured as {
        sourceRevision: string;
      };
      writeFileSync(file, NOTE.replace("## Tokens\n", "## Tokens\n\n```mermaid\nflowchart LR\n```\n"));
      await app.call("write_diagram", {
        viewId: "notes/auth.md#refresh",
        source: "%% archer-id: refresh\nflowchart TB\n",
        expectedRevision: sourceRevision,
      });
    } finally {
      app.close();
    }
  });

  test("a body's revision is of its exact bytes: CRLF and LF bodies differ", async () => {
    const lf = setUp();
    const crlf = setUp(NOTE.replace(/\n/g, "\r\n"));
    try {
      const a = (await lf.app.call("read_diagram", { viewId: "notes/auth.md#refresh" })).structured as {
        sourceRevision: string;
      };
      const b = (await crlf.app.call("read_diagram", { viewId: "notes/auth.md#refresh" })).structured as {
        sourceRevision: string;
      };
      expect(a.sourceRevision).not.toBe(b.sourceRevision);
    } finally {
      lf.app.close();
      crlf.app.close();
    }
  });

  test("keeps a byte-order mark", async () => {
    const { app, file } = setUp(`﻿${NOTE}`);
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: LOGIN })).structured as {
        sourceRevision: string;
      };
      await app.call("write_diagram", {
        viewId: LOGIN,
        source: 'flowchart LR\n  a["A"]\n',
        expectedRevision: sourceRevision,
      });
      expect([...readFileSync(file).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    } finally {
      app.close();
    }
  });

  test("refuses a write that would make the note larger than a note may be", async () => {
    const { app, note } = setUp(`${"p".repeat(900_000)}\n\n${NOTE}`);
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: LOGIN })).structured as {
        sourceRevision: string;
      };
      const refused = await refusal(
        app.call("write_diagram", {
          viewId: LOGIN,
          source: `flowchart LR\n%% ${"x".repeat(200_000)}\n`,
          expectedRevision: sourceRevision,
        }),
      );
      expect(refused).toMatchObject({ code: "invalid_request", message: expect.stringContaining("larger than") });
      expect(note().length).toBe(900_002 + NOTE.length);
    } finally {
      app.close();
    }
  });

  test("refuses a source whose archer-id takes another diagram's name, or is no name", async () => {
    const { app, note } = setUp();
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: LOGIN })).structured as {
        sourceRevision: string;
      };
      for (const source of ["%% archer-id: refresh\nflowchart LR\n", "%% archer-id: bad/id\nflowchart LR\n"]) {
        const refused = await refusal(
          app.call("write_diagram", { viewId: LOGIN, source, expectedRevision: sourceRevision }),
        );
        expect(refused.code, source).toBe("invalid_request");
      }
      expect(note()).toBe(NOTE);
      // Renaming it to a free name is allowed, and says where it is now.
      const renamed = await app.call("write_diagram", {
        viewId: LOGIN,
        source: "%% archer-id: sign-in\nflowchart LR\n",
        expectedRevision: sourceRevision,
      });
      expect(renamed.structured).toMatchObject({ address: "notes/auth.md#sign-in" });
    } finally {
      app.close();
    }
  });

  test("refuses a source that would close its fence early, and writes nothing", async () => {
    const { app, note } = setUp();
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: LOGIN })).structured as {
        sourceRevision: string;
      };
      const refused = await refusal(
        app.call("write_diagram", {
          viewId: LOGIN,
          source: "flowchart TB\n```\n# injected\n",
          expectedRevision: sourceRevision,
        }),
      );
      expect(refused).toMatchObject({ code: "invalid_request", message: expect.stringContaining("close its fence") });
      expect(note()).toBe(NOTE);
    } finally {
      app.close();
    }
  });
});

test("the source resource of an embedded diagram is its block's body, at an encoded URI", async () => {
  const { sourceUri } = await import("../../src/application/tools.ts");
  const { connect } = await import("../mcp/support.ts");
  const root = tempDir({ ".archer/notes/auth.md": NOTE });
  const { client, close } = await connect({ cwd: root });
  try {
    expect(sourceUri(LOGIN)).toBe("archer://diagram/notes%2Fauth.md%23login-flow/source");
    expect(sourceUri("flow")).toBe("archer://diagram/flow/source");
    const read = await client.readResource({ uri: sourceUri(LOGIN) });
    expect((read.contents[0] as { text: string }).text).toBe('flowchart LR\n  user["User"] e1@--> api["API"]\n');
  } finally {
    await close();
  }
});

// The first export in a worker loads and transforms the whole export painter
// (~1 s idle here, CPU-bound; warm exports take ~40 ms), which overran the 5 s
// default on a loaded CI runner. Real exports get the bound the export suite uses.
test("export_diagram of a valid embedded diagram is no last-good export", async () => {
  const { app } = setUp();
  try {
    const exported = await app.call("export_diagram", { viewId: LOGIN, format: "svg" });
    expect(exported.structured).toMatchObject({ lastGood: false });
  } finally {
    app.close();
  }
}, 20_000);

test("set_selection takes the reader stamp of the longest address", async () => {
  const { TOOLS } = await import("../../src/application/tools.ts");
  const schema = TOOLS.find((t) => t.name === "set_selection")!.inputSchema as unknown as {
    properties: { presentationId: { maxLength: number } };
  };
  expect(schema.properties.presentationId.maxLength).toBeGreaterThanOrEqual("reader:".length + 1200);
});

// A block nested in a list or blockquote: moved to the top level only when
// the note is the agent's own (`author: agent`) or the person asked.
describe("write_diagram relocate", () => {
  const nested = (frontMatter: string) =>
    `${frontMatter}# Plan\n\nIntro.\n\n- Step one\n- Step two, drawn:\n\n  \`\`\`mermaid\n  flowchart LR\n    a["A"]\n  \`\`\`\n\n- Step three\n\nAfter the list.\n`;
  const ADDR = "notes/auth.md#plan";
  const SOURCE = 'flowchart LR\n  a["A"] e1@--> b["B"]\n';
  const moved = (frontMatter: string) =>
    `${frontMatter}# Plan\n\nIntro.\n\n- Step one\n- Step two, drawn:\n\n\n- Step three\n\n\`\`\`mermaid\n%% archer-id: plan\n${SOURCE}\`\`\`\n\nAfter the list.\n`;

  async function attempt(text: string, extra: Record<string, unknown>) {
    const { app, note } = setUp(text);
    try {
      const { sourceRevision } = (await app.call("read_diagram", { viewId: ADDR })).structured as {
        sourceRevision: string;
      };
      const outcome = await app
        .call("write_diagram", { viewId: ADDR, source: SOURCE, expectedRevision: sourceRevision, ...extra })
        .then(
          (r) => ({ ok: r.structured }),
          (e: OperationError) => ({ refused: { code: e.data.code, message: e.message } }),
        );
      return { outcome, after: note() };
    } finally {
      app.close();
    }
  }

  test("is refused by default, and in the person's note without their request", async () => {
    const plain = nested("");
    for (const extra of [{}, { relocate: true }, { relocate: true, personRequested: false }]) {
      const { outcome, after } = await attempt(plain, extra);
      expect(outcome, JSON.stringify(extra)).toMatchObject({ refused: { code: "invalid_request" } });
      expect(after).toBe(plain);
    }
    const { outcome } = await attempt(plain, { relocate: true });
    expect((outcome as { refused: { message: string } }).refused.message).toMatch(
      /author: agent.*personRequested|personRequested.*author: agent/s,
    );
  });

  test("moves the block below its list in the agent's own note, pinned, and touches no other prose", async () => {
    const front = "---\nauthor: agent\n---\n";
    const { outcome, after } = await attempt(nested(front), { relocate: true });
    expect(outcome).toMatchObject({ ok: { status: "compiled", address: ADDR } });
    expect(after).toBe(moved(front));
  });

  test("moves it in the person's note when they asked", async () => {
    const { outcome, after } = await attempt(nested(""), { relocate: true, personRequested: true });
    expect(outcome).toMatchObject({ ok: { status: "compiled", address: ADDR } });
    expect(after).toBe(moved(""));
  });

  test("the tool says when relocating is allowed", async () => {
    const { TOOLS } = await import("../../src/application/tools.ts");
    const write = TOOLS.find((t) => t.name === "write_diagram")!;
    const props = (
      write.inputSchema as unknown as { properties: Record<string, { type: string; description: string }> }
    ).properties;
    expect(props["relocate"]).toMatchObject({ type: "boolean" });
    expect(props["personRequested"]).toMatchObject({ type: "boolean" });
    expect(write.description).toMatch(/author: agent/);
    expect(write.description).toMatch(/personRequested/);
  });
});
