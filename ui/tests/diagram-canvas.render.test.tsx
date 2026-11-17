// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DiagramCanvas } from "../src/diagrams/DiagramCanvas";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { computeSequenceLayout } from "../src/layout/sequence-layout";
import { projectEnvelope } from "../src/diagrams/projection";
import { loadValidFixture } from "./fixtures";
import { readStylesheet } from "./stylesheet";
import { pinsOn } from "./support/pins";

async function layoutFixture(name: string): Promise<LayoutResult> {
  const projection = projectEnvelope(loadValidFixture(name));
  if (!projection.ok || projection.type !== "graph") {
    throw new Error(`fixture ${name} did not project to a graph view`);
  }
  return computeLayout(projection.view);
}

let dataFlowLayout: LayoutResult;

beforeAll(async () => {
  dataFlowLayout = await layoutFixture("minimal-data-flow.json");
});

afterEach(cleanup);

describe("DiagramCanvas rendering", () => {
  it("renders a placeholder when no diagram is selected", () => {
    render(<DiagramCanvas state={{ status: "empty" }} />);
    expect(screen.getByText("No diagram selected")).toBeInTheDocument();
  });

  it("renders a placeholder while layout is in flight", () => {
    render(<DiagramCanvas state={{ status: "loading" }} />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders a node per layout node and an edge per layout edge", async () => {
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout: dataFlowLayout }} />);

    expect(screen.getByText("Web")).toBeInTheDocument();
    expect(screen.getByText("API")).toBeInTheDocument();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(dataFlowLayout.nodes.length);

    // Edges only appear once react-flow has measured the nodes.
    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(dataFlowLayout.edges.length);
    });
    expect(container.querySelector('.react-flow__edge[data-id="request"]')).not.toBeNull();
  });

  it("renders focused elements distinctly from dimmed ones", async () => {
    const { container } = render(
      <DiagramCanvas state={{ status: "ready", layout: dataFlowLayout, focus: { nodeIds: ["web"] } }} />,
    );

    const opacityOf = (selector: string): string => {
      const element = container.querySelector<HTMLElement>(selector);
      expect(element, selector).not.toBeNull();
      return element!.style.opacity;
    };

    expect(opacityOf('.react-flow__node[data-id="web"]')).toBe("1");
    expect(opacityOf('.react-flow__node[data-id="api"]')).toBe("0.25");

    await waitFor(() => {
      expect(container.querySelector('.react-flow__edge[data-id="request"]')).not.toBeNull();
    });
    // The edge is not in the focus set, so it dims with the rest of the diagram.
    expect(
      container.querySelector<SVGPathElement>('.react-flow__edge[data-id="request"] .react-flow__edge-path')?.style
        .opacity,
    ).toBe("0.25");
  });

  it("keeps a comment pin at full strength on a box the focus has dimmed", async () => {
    const { container } = render(
      <DiagramCanvas
        state={{ status: "ready", layout: dataFlowLayout, focus: { nodeIds: ["web"] } }}
        commented={pinsOn({ nodes: ["web", "api"] })}
      />,
    );
    // The wrapper still carries the fade's opacity as state; the stylesheet lifts a dimmed wrapper back to full
    // strength and fades only its shapes (`.react-flow__node.archer-dimmed`, round 1 C-07), which jsdom does not
    // apply. So the pin stays in its box -- where the reader and the page look for it -- and is not faded with it.
    // (It used to be lifted out of the box, from before that rule, when the whole box faded by opacity.)
    const box = container.querySelector<HTMLElement>('.react-flow__node[data-id="api"]')!;
    expect(box.style.opacity).toBe("0.25");
    expect(box.classList.contains("archer-dimmed")).toBe(true);
    expect(readStylesheet()).toMatch(/\.react-flow__node\.archer-dimmed \{\s*opacity: 1 !important;/);
    const dimmed = await waitFor(() => {
      const pin = box.querySelector('.archer-pins[data-owner="api"] .archer-pin');
      expect(pin).not.toBeNull();
      return pin!;
    });
    // Nothing between the pin and its box fades it.
    for (let n: Element | null = dimmed; n !== null && n !== box; n = n.parentElement)
      expect((n as HTMLElement).style?.opacity || "1").toBe("1");
    // A box in focus keeps its pin inside it, as before.
    expect(container.querySelector('.react-flow__node[data-id="web"] .archer-pin')).not.toBeNull();
  });

  it("leaves every element at full opacity when no focus is set", () => {
    const { container } = render(<DiagramCanvas state={{ status: "ready", layout: dataFlowLayout }} />);

    for (const id of ["web", "api"]) {
      const node = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
      expect(node, id).not.toBeNull();
      expect(node!.style.opacity, id).toBe("1");
    }
  });

  it("keeps the last valid diagram on screen behind an error banner", () => {
    render(<DiagramCanvas state={{ status: "error", message: "boom", lastValid: dataFlowLayout }} />);

    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByText("Web")).toBeInTheDocument();
  });

  it("keeps reporting selection while an error banner is showing", async () => {
    const selections: string[][] = [];
    const { container } = render(
      <DiagramCanvas
        state={{ status: "error", message: "boom", lastValid: dataFlowLayout }}
        onSelectionChange={({ nodes }) => selections.push(nodes.map((n) => n.id))}
      />,
    );

    const web = container.querySelector<HTMLElement>('.react-flow__node[data-id="web"]');
    expect(web).not.toBeNull();
    fireEvent.click(container.querySelector<HTMLButtonElement>('button[aria-label="Select mode"]')!);
    fireEvent.click(web!);

    await waitFor(() => {
      expect(selections.some((ids) => ids.includes("web"))).toBe(true);
    });
  });

  it("shows only the message when there is no last valid diagram", () => {
    const { container } = render(<DiagramCanvas state={{ status: "error", message: "boom" }} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(0);
  });

  it("delegates sequence layouts to the sequence canvas", () => {
    const projection = projectEnvelope(loadValidFixture("minimal-sequence.json"));
    expect(projection.ok).toBe(true);
    if (!projection.ok || projection.type !== "sequence") return;

    render(
      <DiagramCanvas
        state={{
          status: "sequence-ready",
          sequenceLayout: computeSequenceLayout(projection.view),
        }}
      />,
    );

    expect(screen.getByLabelText("Sequence diagram canvas")).toBeInTheDocument();
    expect(screen.getByText("Client")).toBeInTheDocument();
  });
});
