// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { authoringClient } from "../src/authoring/client";
import { STARTER_PREVIEW, STARTER_SOURCE } from "../../shared/authoring-starter.mts";
test("client refuses unstamped mutations and preserves explicit stale generations without refreshing or replaying", async () => {
  const old = "gen_" + "a".repeat(32),
    current = "gen_" + "b".repeat(32),
    bodies: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ message: "authoring_generation_retired" }), { status: 409 });
    }
    return new Response(
      JSON.stringify({
        authorized: true,
        edit: { enabled: true },
        storeId: "store_" + "c".repeat(32),
        generation: current,
        drafts: [],
        operations: [],
        nextOffset: null,
      }),
    );
  });
  const api = authoringClient(fetcher),
    request = {
      op: "document.publish" as const,
      operationId: "1".repeat(32),
      path: "flow.mmd",
      source: "flowchart LR\n",
    };
  await expect(api.mutate(request)).rejects.toThrow("generation");
  expect(fetcher).not.toHaveBeenCalled();
  await api.status();
  await expect(api.mutate(request)).rejects.toThrow("generation");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(api.mutate({ ...request, journalGeneration: old })).rejects.toThrow("authoring_generation_retired");
  expect(bodies).toEqual([{ ...request, journalGeneration: old }]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test("an authorized status names whether editing is on; one without `edit` is not a status this page reads", async () => {
  const status = {
    authorized: true,
    storeId: "store_" + "c".repeat(32),
    generation: "gen_" + "b".repeat(32),
    drafts: [],
    operations: [],
    nextOffset: null,
  };
  const answer = (body: unknown) => authoringClient(async () => new Response(JSON.stringify(body))).status();
  await expect(answer({ ...status, edit: { enabled: false, reason: "project" } })).resolves.toMatchObject({
    authorized: true,
    edit: { enabled: false, reason: "project" },
  });
  await expect(answer(status)).rejects.toThrow();
});
test("the new-diagram starter is previewed from the answer the page holds, without a request; any other source is sent", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ envelope: null, diagnostics: [] })));
  const api = authoringClient(fetcher);
  expect(await api.preview(STARTER_SOURCE)).toEqual(STARTER_PREVIEW);
  expect(fetcher).not.toHaveBeenCalled();
  await api.preview("flowchart LR\n a[A]\n");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
