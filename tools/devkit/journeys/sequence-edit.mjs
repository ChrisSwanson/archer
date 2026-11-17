// Sequence editing in place: draw a message between lifelines, drag its end to another lifeline,
// reorder a participant, change a message through the panel, add a note, wrap messages in a Loop,
// Save, and assert the saved Mermaid.
import { KNOWN } from "./flowchart-create.mjs";
export const meta = { name: "sequence-edit", invariants: KNOWN };

export default async ({ ui, step, expect }) => {
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/seq.mmd");
  await ui.enterEdit();
  const drawn = await ui.seq.drawMessage("s", "d", { label: "write audit" });
  await ui.seq.dragMessageEnd(drawn, "target", "c");
  await step("redrawn message now ends at Client", async () => {
    const m = (await ui.seq.messages()).find((x) => x.id === drawn);
    expect(m?.label ?? "").toMatch(/Server to Client/);
  });
  await ui.seq.reorderParticipant("d", "c"); // Database moves to the left of Client
  await step("Database is now first", async () => expect((await ui.seq.participants())[0]).toBe("d"));
  await ui.seq.panel.set("msg-0", { type: "async" });
  await ui.seq.addNote(["c", "s"]);
  await ui.seq.wrap(["msg-1", "msg-2"], "Loop");
  await ui.save();
  await step("saved source has the new message, order, note, async arrow and loop", async () => {
    const text = await ui.readProjectFile("journeys", ".archer/diagrams/seq.mmd");
    expect(text).toContain("write audit");
    expect(text).toMatch(/s->>c: write audit/);
    const order = [...text.matchAll(/^\s*participant (\w+)/gm)].map((m) => m[1]);
    expect(order[0]).toBe("d");
    expect(text).toMatch(/c-\)s: POST \/login/);
    expect(text).toMatch(/Note over c,\s*s:/i);
    expect(text).toMatch(/^\s*loop /m);
    expect(text).toMatch(/^\s*end\s*$/m);
  });
};
