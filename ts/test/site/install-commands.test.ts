import { expect, it } from "vitest";
import { installCommands } from "../../../site/.vitepress/theme/install-commands.mts";

it("shows a short form whose parts are the exact command, so selecting or copying it gives the whole command", () => {
  expect(installCommands.map((entry) => entry.id)).toEqual(["npx", "curl"]);
  for (const entry of installCommands) {
    expect(entry.shown.join("")).toBe(entry.command);
    // The middle is the long address the short form leaves out; the ends say what runs.
    expect(entry.shown[1]).toMatch(/^https:\/\/.*\/$/);
    expect(entry.note.length).toBeGreaterThan(0);
  }
  expect(installCommands[1]!.note).toMatch(/SHA-256/);
});
