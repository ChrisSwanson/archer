// The journey profile: IDs derived from names, and each construct it refuses,
// at the place it is written, with what to write instead.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { idFromName } from "../../src/mermaid/journey/scan.ts";
import { refusals } from "./support/refusals.ts";

const J = (body: string) => `journey\n  section Morning\n${body}\n`;

describe("IDs from names", () => {
  test.each([
    ["Make tea", "make-tea"],
    ["  Go -- up!  ", "go-up"],
    ["Café visit", "caf-ue9-visit"],
    ["お茶", "u304a-u8336"],
    ["Step 2", "step-2"],
    ["Caf#233; visit", "caf-ue9-visit"],
    ["Fix #35;12#59; ship", "fix-12-ship"],
  ])("%j is %j", (name, id) => {
    expect(idFromName(name)).toBe(id);
  });

  test("an ID is the same wherever the task stands", async () => {
    const first = await compile(J("    Make tea: 3: Me\n    Read: 4: Me"));
    const moved = await compile(J("    Wake up: 2: Me\n    Read: 4: Me\n    Make tea: 3: Me"));
    const ids = (result: typeof first) =>
      result.model?.type === "user-journey" ? result.model.sections.flatMap((s) => s.tasks.map((t) => t.id)) : [];
    expect(ids(first)).toEqual(["make-tea", "read"]);
    expect(ids(moved)).toEqual(["wake-up", "read", "make-tea"]);
  });
});

describe("refused", () => {
  refusals([
    { name: "a task before any section", source: "journey\n  Wake up: 3: Me\n", errors: ["task_outside_section@2:3"] },
    { name: "a score above five", source: J("    Wake up: 7: Me"), errors: ["invalid_score@3:14"] },
    { name: "a score that is not a number", source: J("    Wake up: high: Me"), errors: ["invalid_score@3:14"] },
    {
      name: "two tasks whose names give one ID",
      source: J("    Make tea: 3\n    make  TEA: 4"),
      errors: ["duplicate_id@4:5"],
      says: "rename",
    },
    { name: "a task named only with punctuation", source: J("    ...: 3"), errors: ["invalid_id@3:5"] },
    { name: "a task with no score", source: J("    Wake up"), errors: ["unsupported_construct@3:5"] },
    { name: "an empty actor", source: J("    Wake up: 3: Me,"), errors: ["expected_label@3:20"] },
    {
      name: "a `#`, which Mermaid reads as a comment",
      source: J("    Tea # milk: 3"),
      errors: ["unsupported_construct@3:9"],
      hint: "    Tea #35; milk: 3",
      fixedByHints: true,
    },
    {
      name: "a `;`, which Mermaid reads as the statement's end",
      source: J("    Tea; milk: 3"),
      errors: ["unsupported_construct@3:8"],
      hint: "    Tea#59; milk: 3",
      fixedByHints: true,
    },
    {
      name: "HTML in an actor",
      source: J("    Wake up: 3: <b>Me</b>"),
      errors: ["unsupported_construct@3:17"],
      says: "HTML",
    },
    {
      name: "a second title",
      source: "journey\n  title A\n  title B\n  section S\n    t: 3\n",
      errors: ["duplicate_title@3:3"],
    },
    {
      name: "a comment after a task",
      source: J("    Wake up: 3 %% why"),
      errors: ["unsupported_construct@3:16"],
      hint: "    %% why\n    Wake up: 3",
    },
  ]);
});

describe("read", () => {
  test("a section with no tasks is kept, as Mermaid keeps it", async () => {
    const result = await compile("journey\n  section Empty\n  section Full\n    Work: 3\n");
    expect(result.model).toMatchObject({ sections: [{ id: "section-empty", tasks: [] }, { id: "section-full" }] });
  });

  test("a task with no actors", async () => {
    const result = await compile(J("    Wake up: 2"));
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toEqual({
      type: "user-journey",
      actors: [],
      sections: [
        { id: "section-morning", label: "Morning", tasks: [{ id: "wake-up", label: "Wake up", score: 2, actors: [] }] },
      ],
    });
  });
});
