import type { Locator } from "@playwright/test";

/**
 * The platform's keys for text editing, where they differ. On macOS, End and Home in a text field scroll and leave
 * the caret where it is (the Cocoa key bindings: `scrollToEndOfDocument:`; Playwright applies them to Chromium on a
 * Mac), and ⌘→ moves to the line's end. Control+C there is not copy either: press `ControlOrMeta+c`. Use these where
 * a test means "the caret to the end" or "copy", not the literal key (docs/agents/ui-testing.md, "Keys on macOS").
 */
const MAC = process.platform === "darwin";

/** Move the caret to the end of the field's line, as a user of this platform does. */
export async function caretToLineEnd(field: Locator): Promise<void> {
  await field.press(MAC ? "Meta+ArrowRight" : "End");
}
