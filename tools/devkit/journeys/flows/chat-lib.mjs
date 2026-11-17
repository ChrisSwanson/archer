// The chat bubble's pieces for the flows journeys (J8e, J9e; codex-201, codex-202): the project conversation and the
// document's, the box, Send, and what the chat says (its alert notes, its status line, the restored/kept notices).

export const chatButton = (page) => page.getByRole("button", { name: /^Chat with the agent about/ }).first();
export const chatBox = (page) => page.getByRole("textbox", { name: "Message to the agent", exact: true });

/** Open the chat from its bubble; resolves once its box is there. */
export async function openChat({ page, expect }) {
  await chatButton(page).click();
  await expect(chatBox(page)).toBeVisible();
}

/** Press the chat's Send. */
export const sendChat = (page) =>
  page.locator(".archer-chat-form").getByRole("button", { name: "Send", exact: true }).click();

/** Everything the chat says now: its notes (alerts and kept/restored notices) and its status line. */
export async function chatSays(page) {
  const parts = await page
    .locator(
      ".archer-chat .archer-chat-note, .archer-chat .archer-composer-kept, .archer-chat [data-testid=chat-status]",
    )
    .allTextContents()
    .catch(() => []);
  return parts.join(" | ").replace(/\s+/g, " ").trim();
}

/** The chat's status line alone. */
export const chatStatus = async (page) =>
  (
    (await page
      .getByTestId("chat-status")
      .textContent()
      .catch(() => "")) ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();

/** Talk about the whole project (the switch on a diagram page). */
export const toProject = (page) =>
  page.getByRole("group", { name: "Talk about" }).getByRole("button", { name: "Whole project", exact: true }).click();
