// @vitest-environment jsdom
//
// The view a mode saves and puts back (`useStageView`, 0.6.4 D1): the nested view's mode and open set, then
// the camera once the layout for them is drawn. A camera restore waiting for its layout belongs to that
// diagram and that press: another diagram, or a later press, cancels it. A live redraw (the same
// presentation, viewport kept) is not a new framing.
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CameraHandle } from "../src/diagrams/DiagramCanvas";
import type { ProjectedView } from "../src/diagrams/projection";
import { useStageView, type Stage } from "../src/app/diagram-stage";
import type { SavedView } from "../src/app/diagram-mode";

const view = (viewId: string): ProjectedView => ({
  viewId,
  kind: "c4",
  title: viewId,
  revision: "r1",
  modelType: "graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: "box" },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [],
  groups: [{ id: "box", label: "Box", parentId: undefined }],
});

type Fake = {
  projectedRef: { current: { type: "graph"; view: ProjectedView } };
  nestRef: { current: { viewId: string; mode: "nested" | "full"; open: string[]; press: number } };
  cameraRef: { current: CameraHandle | null };
  presentation: {
    presentationId: string;
    viewId: string;
    generation: number;
    viewport: "fit-all" | "fit-focus" | "preserve";
  };
  drawnNest: { press: number } | null;
  drawnAt: { viewId: string; mode: "nested" | "full"; press: number } | null;
  cameraBound: number;
  bumpNest: () => void;
};

function setup(viewId = "A") {
  const camera = { get: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })), set: vi.fn(), fit: vi.fn() };
  const stage: Fake = {
    projectedRef: { current: { type: "graph", view: view(viewId) } },
    nestRef: { current: { viewId, mode: "nested", open: [], press: 0 } },
    cameraRef: { current: camera },
    presentation: { presentationId: viewId, viewId, generation: 1, viewport: "fit-all" },
    drawnNest: { press: 0 },
    drawnAt: { viewId, mode: "nested", press: 0 },
    cameraBound: 1,
    bumpNest: vi.fn(),
  };
  const follow = { on: true, set: vi.fn() };
  const hook = renderHook((s: Fake) => useStageView({ ...s } as unknown as Stage, follow), { initialProps: stage });
  return {
    stage,
    camera,
    hook,
    rerender: (over: Partial<Fake> = {}) => {
      Object.assign(stage, over);
      hook.rerender({ ...stage });
    },
  };
}

const SAVED: SavedView = {
  viewId: "A",
  nest: "nested",
  open: ["box"],
  camera: { x: 10, y: 20, zoom: 2 },
  follow: true,
  framing: 1,
};

describe("useStageView", () => {
  it("puts the open set back, and the camera once that layout is drawn", () => {
    const t = setup();
    t.hook.result.current.restore(SAVED, { alsoOpen: null, camera: true });
    expect(t.stage.nestRef.current.open).toEqual(["box"]);
    expect(t.camera.set).not.toHaveBeenCalled();
    const press = t.stage.nestRef.current.press;
    t.rerender({ drawnNest: { press }, drawnAt: { viewId: "A", mode: "nested", press } });
    expect(t.camera.set).toHaveBeenCalledWith(SAVED.camera);
  });

  it("puts the nested view back after a switch to the whole diagram, and frames once that is drawn", () => {
    const t = setup();
    t.stage.nestRef.current = { ...t.stage.nestRef.current, mode: "full" };
    t.rerender({ drawnNest: null });
    t.hook.result.current.restore(SAVED, { alsoOpen: null, camera: true });
    expect(t.stage.nestRef.current.mode).toBe("nested");
    const press = t.stage.nestRef.current.press;
    t.rerender({ drawnNest: { press }, drawnAt: { viewId: "A", mode: "nested", press } });
    expect(t.camera.set).toHaveBeenCalledWith(SAVED.camera);
  });

  it("a restore waiting for its layout never lands on another diagram", () => {
    const t = setup();
    t.hook.result.current.restore(SAVED, { alsoOpen: null, camera: true });
    const press = t.stage.nestRef.current.press;
    // Diagram B takes the stage before A's layout lands, and the person presses on B up to the same number.
    t.stage.projectedRef.current = { type: "graph", view: view("B") };
    t.stage.nestRef.current = { viewId: "B", mode: "nested", open: ["box"], press };
    t.rerender({ drawnNest: { press }, drawnAt: { viewId: "B", mode: "nested", press } });
    expect(t.camera.set).not.toHaveBeenCalled();
  });

  it("a later press on the same diagram cancels the restore's camera", () => {
    const t = setup();
    t.hook.result.current.restore(SAVED, { alsoOpen: null, camera: true });
    const press = t.stage.nestRef.current.press;
    t.stage.nestRef.current = { ...t.stage.nestRef.current, open: [], press: press + 1 };
    t.rerender({ drawnNest: { press: press + 1 }, drawnAt: { viewId: "A", mode: "nested", press: press + 1 } });
    expect(t.camera.set).not.toHaveBeenCalled();
  });

  it("with no camera mounted (editing), the restore waits for the reader's camera and applies it then", () => {
    const t = setup();
    const held = t.stage.cameraRef.current!;
    t.stage.cameraRef.current = null;
    t.hook.result.current.restore(SAVED, { alsoOpen: null, camera: true });
    const press = t.stage.nestRef.current.press;
    t.rerender({ drawnNest: { press }, drawnAt: { viewId: "A", mode: "nested", press } });
    t.stage.cameraRef.current = held;
    t.rerender({ cameraBound: t.stage.cameraBound + 1 });
    expect(t.camera.set).toHaveBeenCalledWith(SAVED.camera);
  });

  it("no camera saved (a walkthrough opened from a link): the restored layout is fitted instead", () => {
    const t = setup();
    t.hook.result.current.restore({ ...SAVED, camera: null }, { alsoOpen: null, camera: true });
    const press = t.stage.nestRef.current.press;
    t.rerender({ drawnNest: { press }, drawnAt: { viewId: "A", mode: "nested", press } });
    expect(t.camera.fit).toHaveBeenCalled();
    expect(t.camera.set).not.toHaveBeenCalled();
  });

  it("a live redraw (the same presentation, viewport kept) is not a new framing; a framing presentation is", () => {
    const t = setup();
    const first = t.hook.result.current.framing;
    expect(typeof first).toBe("number");
    t.rerender({ presentation: { ...t.stage.presentation, generation: 2, viewport: "preserve" } });
    expect(t.hook.result.current.framing).toBe(first);
    t.rerender({ presentation: { ...t.stage.presentation, generation: 3, viewport: "fit-focus" } });
    expect(t.hook.result.current.framing).not.toBe(first);
  });
});
