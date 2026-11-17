// Embedded diagrams in notes: Source shows the block, edit in place, Save keeps the note's other bytes identical.
// Runs on awkward/notes/embedded-families.md and the CRLF note.
import { KNOWN } from "../flowchart-create.mjs";
export const meta = { name: "smoke-c-embedded-note", invariants: KNOWN };
const stripBlock = (text, id) =>
  text.replace(new RegExp("```mermaid\\r?\\n%% archer-id: " + id + "\\r?\\n[\\s\\S]*?```"), "<<BLOCK>>");
export default async ({ ui, step, expect, page }) => {
  const note = "notes/embedded-families.md";
  await ui.resetProject("awkward");
  const before = await ui.readProjectFile("awkward", ".archer/" + note);
  await ui.openDiagram("awkward", note + "#flow");
  const shown = await ui.openSourcePanel();
  await step("Source shows the embedded block's mermaid", () => expect(shown).toContain("flowchart LR"));
  await step("Source text excludes the note's prose", () =>
    expect(shown).not.toContain("Embedded diagrams of every family"),
  );
  await ui.editSourceFromPanel();
  await step("editor URL keeps the #flow anchor", () => expect(page.url()).toContain("#flow"));
  await ui.toggleEditorSource();
  const id = await ui.addPart("Process", { name: "Cache" });
  await ui.save();
  const after = await ui.readProjectFile("awkward", ".archer/" + note);
  await step("saved: block changed, rest of note byte-identical", () => {
    expect(after).toContain("Cache");
    expect(stripBlock(after, "flow")).toBe(stripBlock(before, "flow"));
  });
  await step("saved note keeps line endings", () => expect(after.includes("\r\n")).toBe(before.includes("\r\n")));
  // sequence block in the same note
  await ui.openDiagram("awkward", note + "#seq", { edit: true });
  await ui.addPart("Participant", { name: "Cache" });
  await ui.save();
  const after2 = await ui.readProjectFile("awkward", ".archer/" + note);
  await step("sequence block saved; other blocks untouched", () => {
    expect(after2).toContain("Cache");
    expect(stripBlock(stripBlock(after2, "flow"), "seq")).toBe(stripBlock(stripBlock(before, "flow"), "seq"));
  });
  // CRLF note
  const crlf = "notes/crlf-note.md";
  const cb = await ui.readProjectFile("awkward", ".archer/" + crlf);
  const m = cb.match(/archer-id: (\S+)/);
  await step("crlf note has an embedded block", () => expect(m).not.toBeNull());
  await ui.openDiagram("awkward", `${crlf}#${m[1]}`, { edit: true });
  await ui.addPart(cb.includes("sequenceDiagram") ? "Participant" : "Process", { name: "Zed" });
  await ui.save();
  const ca = await ui.readProjectFile("awkward", ".archer/" + crlf);
  await step("crlf note stays all-CRLF after save", () => expect(/(?<!\r)\n/.test(ca)).toBe(false));
};
