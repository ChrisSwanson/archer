// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SequenceCanvas } from "../src/diagrams/SequenceCanvas";
import { projectEnvelope } from "../src/diagrams/projection";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { loadModelEnvelope } from "./fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("sequence pins ignore unrelated subtree edits and coalesce panel mutations", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  let reads = 0;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.matches(".archer-seq-canvas")) {
      reads++;
      return new DOMRect(64, 100, 1200, 700);
    }
    return new DOMRect();
  });
  const envelope = loadModelEnvelope("sequence", "full");
  const projected = projectEnvelope({ ...envelope, view: { ...envelope.view, kind: "sequence" } });
  if (!projected.ok || projected.type !== "sequence") throw new Error("sequence fixture did not project");
  render(
    <SequenceCanvas
      layout={computeSequenceLayout(projected.view)}
      commented={{
        nodeIds: new Set(),
        edgeIds: new Set(),
        groupIds: new Set(["frag-0"]),
        groupPins: new Map([["frag-0", [{ threadId: "t-block", number: 1, state: "sent" }]]]),
      }}
    />,
  );
  const mutations = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  await mutations();
  flush();
  await mutations();
  reads = 0;
  const unrelated = document.createElement("p");
  document.body.append(unrelated);
  await mutations();
  expect(reads).toBe(0);
  const panel = document.createElement("aside");
  panel.className = "archer-diagram-panel";
  document.body.append(panel);
  await mutations();
  panel.style.width = "300px";
  await mutations();
  expect(reads).toBe(0);
  flush();
  expect(reads).toBe(1);
  panel.remove();
  unrelated.remove();
});
