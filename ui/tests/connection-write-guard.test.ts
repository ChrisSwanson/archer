import { expect, it, vi } from "vitest";
import { httpCommentsTransport } from "../src/comments/transport";
import { newOperation, newSubmitOperation } from "../src/comments/operations";

it("keeps reads available but refuses every comment mutation while disconnected", async () => {
  let connected = false;
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ total: 0, targets: [] })));
  const transport = httpCommentsTransport(fetcher, () => connected);
  await expect(transport.pending()).resolves.toEqual({ total: 0, targets: [] });
  fetcher.mockClear();
  for (const mutate of [
    () =>
      transport.createThreadOnce(newOperation("comment.create", "view:flow"), {
        target: "view:flow",
        anchor: { kind: "view" },
        body: "Keep this",
      }),
    () => transport.replyOnce(newOperation("comment.reply", "view:flow"), "thread", "Keep this"),
    () => transport.edit("thread", "comment", "Keep this"),
    () => transport.remove("thread", "comment"),
    () => transport.resolve("thread"),
    () => transport.dismiss("thread"),
    () => transport.submitOnce(newSubmitOperation(), {}),
    () => transport.submitOnce(newSubmitOperation(), { target: "view:flow", threadId: "thread" }),
  ])
    await expect(mutate()).rejects.toThrow("Waiting for Archer to reconnect");
  expect(fetcher).not.toHaveBeenCalled();
  connected = true;
  const operation = newSubmitOperation();
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ operation, replayed: false, submitted: 0 })));
  await transport.submitOnce(operation, {});
  expect(fetcher).toHaveBeenCalledOnce();
});
