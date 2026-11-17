// @vitest-environment jsdom
// An old-version answer belongs to the walkthrough and diagram it was asked for: another one never sees it, not even in the render before the hook resets.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useOldVersion } from "../src/walkthroughs/use-old-version";

afterEach(() => vi.unstubAllGlobals());

it("shows an answer only for the walkthrough and view it was asked for, from the first render", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, viewId: "v", id: "a", status: "refused" }))),
  );
  const seen: string[] = [];
  const { result, rerender } = renderHook(
    ({ view, id }) => {
      const r = useOldVersion(view, id);
      seen.push(`${view}/${id}:${r.old.status}`);
      return r;
    },
    { initialProps: { view: "v" as string | null, id: "a" as string | null } },
  );
  act(() => result.current.open());
  await waitFor(() => expect(result.current.old.status).toBe("refused"));
  seen.length = 0;
  rerender({ view: "v", id: "b" });
  rerender({ view: "w", id: "a" });
  expect(seen.every((s) => s.endsWith(":idle"))).toBe(true);
});
