// @vitest-environment jsdom
// G6, PF-3 (review evidence performance-2026-11-02-draft, private, not published): the navigation leak's second half. A `useCallback`
// value keeps the whole render it was made in (V8 shares one closure context per scope), and that render's other
// callbacks keep theirs. Two callbacks whose inputs change at different times then chain each render to the one
// before it, so a long-lived component like ProjectApp kept one more page per navigation. `useLatestCallback` holds
// only a ref to the latest function and keeps no old render. The first test proves the probe sees the chain.
import { act, cleanup, render } from "@testing-library/react";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { useCallback, type JSX } from "react";
import { afterEach, expect, it } from "vitest";
import { useLatestCallback } from "../src/app/latest-callback";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
afterEach(cleanup);

type Hook = <F extends (...args: never[]) => unknown>(fn: F, deps: readonly unknown[]) => F;
const memoized: Hook = (fn, deps) => useCallback(fn, deps); // eslint-disable-line react-hooks/exhaustive-deps
const latest: Hook = (fn) => useLatestCallback(fn as never) as never;

/** Renders `left` and `right` callbacks that change in turn, each render with its own payload; how many survive. */
async function payloadsKept(hook: Hook): Promise<number> {
  const kept: WeakRef<object>[] = [];
  const held: { left?: () => unknown; right?: () => unknown } = {};
  function Page({ a, b, payload }: { readonly a: number; readonly b: number; readonly payload: object }): JSX.Element {
    // Both callbacks are made in the scope that holds this render's payload, and each names the other, as a large
    // component's handlers do: so the scope's context holds the payload and both callback values.
    const left = hook(() => a + (payload === null ? 0 : 1) + Number(right === undefined), [a]);
    const right = hook(() => b + Number(left === undefined), [b]);
    held.left = left;
    held.right = right;
    return <p>{a + b}</p>;
  }
  const view = render(<Page a={0} b={0} payload={{}} />);
  for (let step = 1; step <= 20; step += 1) {
    const payload = { step, bulk: new Array(1000).fill(step) };
    kept.push(new WeakRef(payload));
    // `a` and `b` change on alternate renders, as the editor's key and the review target do across a navigation.
    act(() => {
      view.rerender(<Page a={Math.ceil(step / 2)} b={Math.floor(step / 2)} payload={payload} />);
    });
  }
  act(() => {
    view.rerender(<Page a={99} b={99} payload={{}} />);
  });
  await new Promise((done) => setTimeout(done, 0));
  gc();
  gc();
  return kept.filter((ref) => ref.deref() !== undefined).length;
}

it("useCallback chains renders: alternating callbacks keep old renders' payloads (the probe sees the leak)", async () => {
  expect(await payloadsKept(memoized)).toBeGreaterThan(5);
});

it("useLatestCallback keeps no old render", async () => {
  expect(await payloadsKept(latest)).toBeLessThanOrEqual(1);
});
