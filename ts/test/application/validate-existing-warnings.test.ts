// validate_diagram listed the label warnings a person's diagram already had beside the agent's
// own, and luna "fixed" them: it rewrote every long label of the person's diagram while making a
// small change (docs/evaluations/eval-baseline.md, emphasis and a hold-out task). Warnings the last commit already
// had are now marked existing and left out of the text; only what the agent adds is listed. The
// baseline is the commit, not the file on disk: in the create flow the agent writes the file first,
// and its own warnings must still be listed (Codex review).
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { renderOperation } from "../../src/application/render.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";
import { cleanup, commit, repo, write } from "../accuracy/support.ts";

afterEach(cleanup);
afterEach(removeTempDirs);

const OLD = 'flowchart LR\n  a["A"] e1@-->|customer tries some other card, then another, then gives up| b["B"]\n';
const ADDED = `${OLD}  b e2@-->|then a refund goes back to the card the customer paid with| c["C"]\n`;
type Diag = { message: string; existing?: true };
const listed = (s: unknown) =>
  (s as { diagnostics: Diag[] }).diagnostics.filter((d) => !d.existing).map((d) => d.message);

test("a warning the committed diagram already had is marked existing and left out of the text", async () => {
  const root = repo({ ".archer/flow.mmd": OLD });
  commit(root);
  write(root, ".archer/flow.mmd", ADDED); // the agent's file edit, then the check
  const app = createApplication({ cwd: root });
  try {
    const checked = await app.call("validate_diagram", { viewId: "flow", source: ADDED });
    expect(listed(checked.structured)).toEqual([expect.stringContaining("'e2'")]);
    expect(
      (checked.structured as { diagnostics: Diag[] }).diagnostics.filter((d) => d.existing).map((d) => d.message),
    ).toEqual([expect.stringContaining("'e1'")]);
    expect(checked.structured).toMatchObject({ existingWarnings: 1 });
    expect(checked.text).toMatch(/1 warning the diagram already had.*leave/i);
    for (const text of [checked.text, renderOperation("validate_diagram", checked)]) expect(text).not.toContain("'e1'");
  } finally {
    app.close();
  }
});

test("a new diagram written before the check has every warning listed", async () => {
  const root = repo({ "README.md": "x\n" });
  commit(root);
  write(root, ".archer/flow.mmd", ADDED);
  const app = createApplication({ cwd: root });
  try {
    const checked = await app.call("validate_diagram", { viewId: "flow", source: ADDED });
    expect(listed(checked.structured)).toHaveLength(2);
    expect(checked.structured).not.toHaveProperty("existingWarnings");
  } finally {
    app.close();
  }
});

test("outside Git every warning is listed", async () => {
  const app = createApplication({ cwd: tempDir({ ".archer/flow.mmd": OLD }) });
  try {
    expect(listed((await app.call("validate_diagram", { viewId: "flow", source: ADDED })).structured)).toHaveLength(2);
  } finally {
    app.close();
  }
});

test("in a note, the committed block's warnings are the existing ones", async () => {
  const note = (body: string) =>
    `---\ntype: process\n---\n\n# Flow\n\n\`\`\`mermaid\n%% archer-id: flow\n${body}\`\`\`\n`;
  const root = repo({ ".archer/notes/flow.md": note(OLD) });
  commit(root);
  const app = createApplication({ cwd: root });
  try {
    const checked = await app.call("validate_diagram", {
      viewId: "notes/flow.md#flow",
      source: `%% archer-id: flow\n${ADDED}`,
    });
    expect(listed(checked.structured)).toEqual([expect.stringContaining("'e2'")]);
  } finally {
    app.close();
  }
});
