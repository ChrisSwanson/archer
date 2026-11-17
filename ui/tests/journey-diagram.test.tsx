// @vitest-environment jsdom
//
// A user journey on a canvas of its own: sections as columns of tasks, each
// task with its score shown as pips AND as words (never colour alone), its
// actors named, and every section and task selectable, emphasisable,
// commentable and reachable by keyboard by its model id.
//
// The envelope is the TypeScript compiler's output for the golden source
// `ts/test/fixtures/journey/widened.mmd`.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinsOn } from "./support/pins";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { App } from "../src/app/App";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { JOURNEY_COLUMN_MAX_PX, JOURNEY_GAP_PX, journeyBoardWidth } from "../src/diagrams/JourneyCanvas";
import { declarationsOf, readStylesheet, rulesOf } from "./stylesheet";
import { projectEnvelope, type ProjectedJourney } from "../src/diagrams/projection";
import { anchorAt, diagramChoices } from "../src/comments/canvas-anchors";
import { parseEmphasis, type Emphasis } from "../src/emphasis/contract";
import type { CommentedElements } from "../src/diagrams/xflow-adapter";
import {
  MockEventSource,
  mountAgentPresented,
  restoreLocation,
  selectionPosts,
  settle,
  settleSelection,
} from "./app-harness";
import { loadModelEnvelope } from "./fixtures";
import { installReducedMotion } from "./match-media";

const JOURNEY = loadModelEnvelope("journey", "widened");

beforeEach(() => {
  installReducedMotion(false);
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreLocation();
});

function projected(): ProjectedJourney {
  const projection = projectEnvelope(JOURNEY);
  if (!projection.ok || projection.type !== "journey") throw new Error("the journey did not project to a journey");
  return projection.view;
}

function drawJourney(
  options: {
    emphasis?: Emphasis | null;
    selection?: { nodeIds?: readonly string[] };
    commented?: CommentedElements;
    focus?: { nodeIds: string[] };
    onNodeClick?: (id: string, additive: boolean) => void;
    onPaneClick?: () => void;
  } = {},
): HTMLElement {
  return render(
    <DiagramCanvas
      state={{
        status: "journey-ready",
        journey: projected(),
        ...(options.focus === undefined ? {} : { focus: options.focus }),
      }}
      emphasis={options.emphasis}
      selection={options.selection}
      commented={options.commented}
      onNodeClick={options.onNodeClick}
      onPaneClick={options.onPaneClick}
    />,
  ).container;
}

const element = (container: HTMLElement, id: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>("[data-journey-id]")].find(
    (el) => el.dataset.journeyId === id,
  );
  expect(found, `nothing is drawn for ${id}`).toBeDefined();
  return found!;
};

describe("a journey projects to a canvas of its own", () => {
  it("keeps sections in order with their tasks, and the actors in order of appearance", () => {
    const view = projected();
    expect(view.heading).toBe("A working day");
    expect(view.actors).toEqual(["Me", "Cat", "Boss"]);
    expect(view.sections.map((section) => section.id)).toEqual([
      "section-go-to-work",
      "section-lunch-at-the-caf-ue9",
      "section-go-home",
    ]);
    expect(view.sections[0].tasks[1]).toEqual({
      id: "go-upstairs",
      label: "Go upstairs",
      score: 3,
      actors: ["Me", "Cat"],
    });
  });

  it("refuses two elements with one id", () => {
    const sections = JOURNEY.model.sections as { id: string; tasks: unknown[] }[];
    const broken = {
      ...JOURNEY,
      model: { ...JOURNEY.model, sections: [sections[0], { ...sections[1], id: sections[0].id }] },
    };
    expect(projectEnvelope(broken).ok).toBe(false);
  });
});

describe("the journey is drawn", () => {
  it("draws a column per section, holding its tasks in order", () => {
    const container = drawJourney();
    const columns = [...container.querySelectorAll(".archer-journey-section")];
    expect(columns.map((column) => column.querySelector(".archer-journey-section-label")?.textContent)).toEqual([
      "Go to work",
      "Lunch at the Café",
      "Go home",
    ]);
    expect([...columns[0].querySelectorAll(".archer-journey-task-label")].map((label) => label.textContent)).toEqual([
      "Make tea",
      "Go upstairs",
      "Do work",
    ]);
    expect(container.querySelector(".archer-journey-title")?.textContent).toBe("A working day");
  });

  it("shows each score as pips and as words, so it never rests on colour", () => {
    const container = drawJourney();
    const task = element(container, "do-work");
    expect(task.querySelectorAll(".archer-journey-pip")).toHaveLength(5);
    expect(task.querySelectorAll(".archer-journey-pip-filled")).toHaveLength(1);
    expect(task.querySelector(".archer-journey-score-text")?.textContent).toBe("1/5");
    expect(task.classList.contains("archer-journey-score-1")).toBe(true);
    expect(element(container, "make-tea").querySelectorAll(".archer-journey-pip-filled")).toHaveLength(5);
  });

  it("names each task with its score and actors, and each section with its size", () => {
    const container = drawJourney();
    expect(element(container, "go-upstairs").getAttribute("aria-label")).toBe("Go upstairs, score 3 of 5, Me and Cat");
    expect(element(container, "read-the-news").getAttribute("aria-label")).toBe(
      'Read the "news", score 3 of 5, no actors',
    );
    expect(element(container, "section-go-home").getAttribute("aria-label")).toBe("Go home, section of 2 tasks");
  });

  it("finishes a task nobody is named for with a row that says so, not an empty bottom edge", () => {
    // Review of 2026-10-04: a task without actors stopped after its score and
    // looked unfinished beside its neighbours.
    const container = drawJourney();
    const task = element(container, "read-the-news");
    expect(task.querySelector(".archer-journey-no-actors")?.textContent).toBe("No actors");
    expect(task.querySelectorAll(".archer-journey-actor")).toHaveLength(0);
    // Its name already says so; the row is for the eye.
    expect(task.querySelector(".archer-journey-no-actors")?.closest("[aria-hidden='true']")).not.toBeNull();
    expect(element(container, "make-tea").querySelector(".archer-journey-no-actors")).toBeNull();
  });

  it("composes the board at the width its columns need, heading and all", () => {
    const container = drawJourney();
    // Three columns at their widest, four gaps: centred in a wider canvas.
    const width = `${3 * JOURNEY_COLUMN_MAX_PX + 4 * JOURNEY_GAP_PX}px`;
    expect(journeyBoardWidth(3)).toBe(1024);
    expect(container.querySelector<HTMLElement>(".archer-journey-board")!.style.maxWidth).toBe(width);
    expect(container.querySelector<HTMLElement>(".archer-journey-head")!.style.maxWidth).toBe(width);
  });

  it("states the column widths the stylesheet draws", () => {
    const rules = rulesOf(readStylesheet());
    const declared = (selector: string, property: string): string | undefined =>
      rules
        .filter((rule) => rule.selectors.includes(selector))
        .flatMap((rule) => declarationsOf(rule.body))
        .find(([name]) => name === property)?.[1];
    expect(declared(".archer-journey-section", "max-width")).toBe(`${JOURNEY_COLUMN_MAX_PX}px`);
    expect(declared(".archer-journey-board", "gap")).toBe(`${JOURNEY_GAP_PX}px`);
    expect(declared(".archer-journey-board", "padding")).toBe(`${JOURNEY_GAP_PX}px`);
  });

  it("names the actors on each task and in a key of their own", () => {
    const container = drawJourney();
    expect(
      [...element(container, "go-upstairs").querySelectorAll(".archer-journey-actor")].map((a) => a.textContent),
    ).toEqual(["Me", "Cat"]);
    expect(
      [...container.querySelectorAll(".archer-journey-actors-key .archer-journey-actor")].map((a) => a.textContent),
    ).toEqual(["Me", "Cat", "Boss"]);
  });
});

describe("tasks and sections take selection, emphasis, comments and the keyboard", () => {
  it("marks the selection, the agent's emphasis and comment marks on tasks and sections", () => {
    const emphasis = parseEmphasis({
      id: "low",
      viewId: JOURNEY.view.id,
      title: "The low point",
      groups: [{ id: "g", style: "highlight", palette: "coral", nodes: ["do-work", "section-go-home"], edges: [] }],
    });
    const container = drawJourney({
      emphasis,
      selection: { nodeIds: ["make-tea", "section-go-to-work"] },
      commented: pinsOn({ nodes: ["sit-down", "section-go-home"] }),
    });
    expect(element(container, "make-tea").classList.contains("selected")).toBe(true);
    expect(element(container, "make-tea").getAttribute("aria-pressed")).toBe("true");
    expect(element(container, "section-go-to-work").classList.contains("selected")).toBe(true);
    expect(element(container, "do-work").classList.contains("archer-emph")).toBe(true);
    expect(element(container, "section-go-home").classList.contains("archer-emph")).toBe(true);
    expect(element(container, "sit-down").querySelector(".archer-pin")?.textContent).toBe("1");
    expect(element(container, "section-go-home").querySelector(".archer-pin")?.textContent).toBe("2");
    expect(element(container, "sit-down").getAttribute("aria-label")).toContain("has comments");
    expect(container.querySelector(".archer-emph-legend")).not.toBeNull();
  });

  it("dims what the presentation does not focus on, unless the agent emphasised it", () => {
    const container = drawJourney({ focus: { nodeIds: ["make-tea"] } });
    expect(element(container, "make-tea").classList.contains("archer-journey-dimmed")).toBe(false);
    expect(element(container, "do-work").classList.contains("archer-journey-dimmed")).toBe(true);
  });

  it("selects by click, Shift-click and Enter, and clears on empty canvas", () => {
    const clicks: string[] = [];
    let cleared = 0;
    const container = drawJourney({
      onNodeClick: (id, additive) => clicks.push(`${id}${additive ? "+" : ""}`),
      onPaneClick: () => (cleared += 1),
    });
    fireEvent.click(element(container, "make-tea"));
    fireEvent.click(element(container, "section-go-home"), { shiftKey: true });
    element(container, "do-work").focus();
    fireEvent.keyDown(element(container, "do-work"), { key: "Enter" });
    expect(clicks).toEqual(["make-tea", "section-go-home+", "do-work"]);
    fireEvent.click(container.querySelector(".archer-journey-board")!);
    expect(cleared).toBe(1);
  });

  it("puts one tab stop on the journey, and walks it with the arrows: down a section, across to the next", () => {
    const container = drawJourney();
    const stops = [...container.querySelectorAll("[data-journey-id]")].filter(
      (el) => el.getAttribute("tabindex") === "0",
    );
    expect(stops.map((el) => (el as HTMLElement).dataset.journeyId)).toEqual(["section-go-to-work"]);
    const at = () => (document.activeElement as HTMLElement | null)?.dataset.journeyId;
    element(container, "section-go-to-work").focus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(at()).toBe("make-tea");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(at()).toBe("go-upstairs");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(at()).toBe("read-the-news");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(at()).toBe("sit-down");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(at()).toBe("go-downstairs");
    expect(element(container, "go-downstairs").getAttribute("tabindex")).toBe("0");
    expect(element(container, "go-downstairs").classList.contains("archer-kbd-focus")).toBe(true);
  });

  it("anchors a comment on a task or a section as a node", () => {
    const container = drawJourney();
    const model = { type: "journey" as const, view: projected() };
    expect(anchorAt(element(container, "go-upstairs").querySelector(".archer-journey-task-label"), model)).toEqual({
      kind: "node",
      id: "go-upstairs",
      label: "Go upstairs",
    });
    expect(anchorAt(element(container, "section-go-home"), model)).toEqual({
      kind: "node",
      id: "section-go-home",
      label: "Go home",
    });
    expect(diagramChoices(model, ["sit-down"], [])[0].anchor).toEqual({
      kind: "node",
      id: "sit-down",
      label: "Sit down",
    });
  });
});

describe("a journey selection reaches the agent", () => {
  it("publishes tasks and sections as nodes, and Cmd+A all of them", async () => {
    const { container } = await mountAgentPresented(<App />, {
      envelope: JOURNEY,
      views: [{ id: JOURNEY.view.id, kind: "journey", title: "Day", registration: "durable" }],
      ready: (mounted) => expect(mounted.querySelectorAll("[data-journey-id]").length).toBe(10),
    });
    fireEvent.click(screen.getByText("Make tea"));
    fireEvent.click(element(container, "section-go-home"), { shiftKey: true });
    await waitFor(() => expect(container.querySelectorAll("[data-journey-id].selected")).toHaveLength(2));
    await settleSelection();
    const last = () => {
      const posts = selectionPosts();
      const [, init] = posts[posts.length - 1] as [string, { body: string }];
      return JSON.parse(init.body) as { nodes: { id: string }[]; edges: unknown[] };
    };
    expect(last().nodes).toEqual([
      { id: "make-tea", label: "Make tea" },
      { id: "section-go-home", label: "Go home" },
    ]);
    act(() => {
      fireEvent.keyDown(window, { key: "a", ctrlKey: true });
    });
    await settle();
    expect(last().nodes).toHaveLength(10);
    expect(last().edges).toEqual([]);
  });
});
