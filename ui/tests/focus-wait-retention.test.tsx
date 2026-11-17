// @vitest-environment jsdom
// G6, PF-3: a focus wait started from an event handler (closing the editor, opening the review) was kept by its
// component until unmount, and kept the control it was started from, so each navigation loop kept that page. A wait
// that has settled must let go of that control; one still waiting is stopped when the component unmounts.
import { act, cleanup, render } from "@testing-library/react";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { JSX } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { focusWhenShown, usePendingFocus } from "../src/app/focus-when-shown";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

let track: ReturnType<typeof usePendingFocus> = () => {};
function Page(): JSX.Element {
  track = usePendingFocus();
  return <p>page</p>;
}

/** Shown to focusWhenShown: jsdom lays nothing out. */
function laidOut(): void {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
}

async function settledWaitKeeps(): Promise<boolean> {
  laidOut();
  render(<Page />);
  let opener: HTMLButtonElement | null = document.createElement("button");
  document.body.append(opener);
  const kept = new WeakRef(opener);
  act(() => {
    track(focusWhenShown("#destination", { from: opener }));
  });
  // The page the wait was started on goes; the destination arrives and takes the focus.
  opener.remove();
  opener = null;
  const destination = document.createElement("h1");
  destination.id = "destination";
  await act(async () => {
    document.body.append(destination);
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(document.activeElement).toBe(destination);
  await new Promise((done) => setTimeout(done, 0));
  gc();
  gc();
  return kept.deref() !== undefined;
}

it("a settled focus wait lets go of the control it started from while its component stays", async () => {
  expect(await settledWaitKeeps()).toBe(false);
});

it("a wait still waiting is stopped when its component unmounts", async () => {
  laidOut();
  const view = render(<Page />);
  const wait = focusWhenShown("#never");
  act(() => {
    track(wait);
  });
  expect(wait.settled()).toBe(false);
  view.unmount();
  expect(wait.settled()).toBe(true);
});
