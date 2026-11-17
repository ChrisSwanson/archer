import type { Section } from "../app/HelpOverlay";
import { shortcutRow } from "../app/shortcuts";

/** The row about sending, which an example chat (no service, no composer) does not have. */
export const CHAT_SEND_KEYS = "Enter / ⇧ Enter";

/** `?` help for the chat bubble, listed while it is on the page (`ChatLauncher`, `ChatPanel`, `C` in `App`). */
export const CHAT_SECTION: Section = {
  section: "Chat with the Agent",
  keys: [
    shortcutRow("comment", "Open the chat about the whole document, when nothing is selected"),
    ["Chat button", "Open the chat; drag it anywhere, it stays where you drop it", "control"],
    ["Arrow keys", "On the chat button: move it 10 px (⇧ 50 px)"],
    ["Home", "On the chat button: move it back to the corner (also its right-click menu)"],
    [CHAT_SEND_KEYS, "In the chat: send the message / start a new line"],
    ["Esc", "Collapse the open chat to the button (it is the first thing Esc closes)"],
  ],
};
