// @vitest-environment jsdom
// G6, PF-3: a media query asked again on every render (the group numbers' system check, reduced motion) made a new
// MediaQueryList each time, and Chromium's style engine keeps each query set it is given: the leak journey saw four
// more per navigation loop. One list per query, for the life of the page.
import { act, cleanup, render } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mediaList, useMediaQuery } from "../src/app/media";
import { useGroupNumbers } from "../src/emphasis/group-numbers";
import { prefersReducedMotion } from "../src/emphasis/reduced-motion";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMatchMedia(): ReturnType<typeof vi.fn> {
  const match = vi.fn(
    (query: string) =>
      ({
        media: query,
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal("matchMedia", match);
  return match;
}

it("asks matchMedia once per query, however often the page renders", () => {
  const match = stubMatchMedia();
  function Page({ n }: { readonly n: number }): JSX.Element {
    const narrow = useMediaQuery("(max-width: 720px)");
    const { numbered } = useGroupNumbers();
    return (
      <p>
        {n}
        {String(narrow)}
        {String(numbered)}
        {String(prefersReducedMotion())}
      </p>
    );
  }
  const view = render(<Page n={0} />);
  for (let n = 1; n <= 10; n += 1)
    act(() => {
      view.rerender(<Page n={n} />);
    });
  view.unmount();
  render(<Page n={11} />);
  const asked = match.mock.calls.map(([query]) => query as string);
  expect(new Set(asked).size).toBe(4);
  expect(asked).toHaveLength(4);
});

it("gives a new stub its own lists", () => {
  const first = stubMatchMedia();
  const a = mediaList("(pointer: coarse)");
  const second = stubMatchMedia();
  expect(mediaList("(pointer: coarse)")).not.toBe(a);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});
