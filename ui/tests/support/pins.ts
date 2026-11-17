/**
 * Threads on elements, as the page hands them to a canvas: through the
 * product's own `commentPins`, from one draft thread per element named, so a
 * canvas test draws exactly the pins the page would.
 */
import type { Anchor, Thread, ThreadStatus } from "../../src/comments/contract";
import { commentPins, type CommentPins } from "../../src/comments/state";

export function pinsOn(
  elements: { nodes?: readonly string[]; edges?: readonly string[]; groups?: readonly string[] },
  status: ThreadStatus = "draft",
): CommentPins {
  const anchors: Anchor[] = [
    ...(elements.nodes ?? []).map((id) => ({ kind: "node" as const, id, label: id })),
    ...(elements.edges ?? []).map((id) => ({ kind: "edge" as const, id, label: id })),
    ...(elements.groups ?? []).map((id) => ({ kind: "group" as const, id, label: id })),
  ];
  const threads: Thread[] = anchors.map((anchor, index) => ({
    id: `t${index + 1}`,
    target: "view:test",
    anchor,
    status,
    revision: 1,
    comments: [{ id: `c${index + 1}`, author: "person", body: "x", createdAt: "2026-10-04T10:00:00Z" }],
  }));
  return commentPins(threads);
}
