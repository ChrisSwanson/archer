// @vitest-environment jsdom
//
// codex-405 (O128): what an edit's Save announces follows the thread as Archer answers it (or as it reads back after
// a lost answer), not the thread before the edit. In immediate mode an edit of a sent comment is published at once, so
// it is "sent", never "a draft again"; in queued mode it is a draft again until the person sends it.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createReviewEvents } from "../src/comments/events";
import { useReview } from "../src/comments/useReview";
import type { Capabilities } from "../src/comments/contract";
import { memoryTransport } from "./support/memory-transport";
import { NO_CAPABILITIES } from "../src/comments/contract";

const CAPS: Capabilities = { ...NO_CAPABILITIES, comments: true, notes: false };

describe.each([
  ["immediate", true],
  ["queued", false],
] as const)("%s mode", (_mode, immediate) => {
  it.each([
    ["ordinary", false],
    ["answer lost", true],
  ] as const)("%s Save of a sent comment: the announcement says what Archer holds", async (_how, lose) => {
    const transport = memoryTransport();
    const made = transport.store.create({ target: "view:v", anchor: { kind: "view" }, body: "Original" });
    transport.store.submit("view:v");
    const edit = transport.edit.bind(transport);
    transport.edit = async (threadId, commentId, body, expected) => {
      let next = await edit(threadId, commentId, body, expected);
      // Immediate mode: the service publishes the edited thread before it answers.
      if (immediate) {
        transport.store.submit("view:v", threadId);
        next = transport.store.list("view:v").find((t) => t.id === threadId)!;
      }
      if (lose) throw new TypeError("Failed to fetch");
      return next;
    };
    const page = renderHook(() =>
      useReview({ transport, capabilities: CAPS, viewId: "v", events: createReviewEvents() }),
    );
    await waitFor(() => expect(page.result.current.threads.get("view:v")?.[0]?.status).toBe("sent"));
    let ok = false;
    await act(async () => {
      ok = await page.result.current.actions.edit(
        page.result.current.threads.get("view:v")![0]!,
        made.comments[0]!.id,
        "Mine",
      );
    });
    expect(ok).toBe(true);
    const said = page.result.current.announcement?.text ?? "";
    if (immediate) {
      expect(said).toBe("Comment updated and sent to the agent.");
      expect(said).not.toMatch(/draft/);
    } else expect(said).toBe("Comment updated. It is a draft again; the agent sees the new text when you send it.");
  });
});
