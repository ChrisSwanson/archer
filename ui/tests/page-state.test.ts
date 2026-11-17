// The page must state ground truth about what exists, independently of what
// the agent claims. An agent that says it drew a diagram and did not, or that
// one is on screen when it is not, has to be contradicted by the page rather
// than covered for by an ambiguous blank canvas.
//
// So these are FIVE DIFFERENT FACTS and they must never collapse into one
// message: nothing is registered; things are registered but none is being
// shown; the thing being shown has been unregistered; we do not know yet; and
// we have lost touch with the server. Each is a different sentence to the
// person reading the screen, and only one of them is true at a time.
//
// The rules live in a pure function so they can be enumerated here rather than
// inferred from what a rendered tree happens to look like.
import { describe, expect, it } from "vitest";
import { pageNotice, type PageStateInput } from "../src/app/page-state";
import type { DiagramView } from "../src/app/inventory";

const view = (id: string): DiagramView => ({
  id,
  kind: "c4-context",
  title: id,
  registration: "durable",
});

/** A connected web page that has heard from the host and knows the registry. */
function web(overrides: Partial<PageStateInput> = {}): PageStateInput {
  return {
    mode: "web",
    connection: "connected",
    heardFromHost: true,
    inventory: "loaded",
    views: [view("a")],
    presentedViewId: "a",
    hasDrawing: true,
    hasCanvasError: false,
    presentedWasRegistered: true,
    bootstrapFailed: false,
    ...overrides,
  };
}

describe("page notice", () => {
  it("says nothing while a diagram is genuinely on screen", () => {
    expect(pageNotice(web())).toBeNull();
  });

  it("says a picked view has never compiled, in place of the drawing that was up", () => {
    // The reader picked this view's tab. Leaving the previous drawing up would
    // be the page answering "show me B" with a picture of A.
    const notice = pageNotice(web({ pickedViewNeverCompiled: true }));

    expect(notice?.kind).toBe("never-compiled");
    expect(notice?.headline).toBe("This diagram has not compiled yet.");
    expect(notice?.detail).toMatch(/no drawing to show/);
  });

  it("still reports an unregistered view first: that one is about what is on screen", () => {
    const notice = pageNotice(web({ views: [], pickedViewNeverCompiled: true }));

    expect(notice?.kind).toBe("unregistered");
  });

  it("says the registry is empty rather than showing a blank canvas", () => {
    const notice = pageNotice(web({ views: [], presentedViewId: null, hasDrawing: false }));

    expect(notice?.kind).toBe("no-diagrams");
    expect(notice?.headline).toBe("No diagrams yet.");
  });

  it("asks the user to choose when diagrams exist but none is presented", () => {
    const notice = pageNotice(web({ presentedViewId: null, hasDrawing: false }));

    // Explicitly NOT auto-selecting the first tab: that would have the page
    // invent a presentation the agent never made.
    expect(notice?.kind).toBe("none-presented");
    expect(notice?.headline).toBe("Select a diagram to view.");
  });

  it("contradicts a drawing whose view has left the registry", () => {
    const notice = pageNotice(web({ views: [view("b")] }));

    // Even though `hasDrawing` is true: what is on screen is no longer live,
    // and continuing to show it would be the page asserting something false.
    expect(notice?.kind).toBe("unregistered");
    expect(notice?.headline).toBe("This diagram is no longer registered.");
  });

  // "No longer registered" is a claim about a change, and it can only be made
  // about a view we actually saw registered. A view that was presented but has
  // never appeared in any listing is ambiguous -- most likely a registration
  // this page has not been told about yet -- and blanking a real drawing over
  // an ambiguity would be its own false statement.
  it("makes no claim about a view it never saw registered", () => {
    const notice = pageNotice(web({ views: [view("b")], presentedWasRegistered: false }));

    expect(notice).toBeNull();
  });

  it("recovers when the view returns to the registry", () => {
    expect(pageNotice(web({ views: [view("a"), view("b")] }))).toBeNull();
  });

  it("says it does not know yet rather than saying nothing exists", () => {
    expect(pageNotice(web({ inventory: "unknown", hasDrawing: false, presentedViewId: null }))?.kind).toBe("loading");
    expect(pageNotice(web({ heardFromHost: false, hasDrawing: false, presentedViewId: null }))?.kind).toBe("loading");
  });

  // The canvas reports what went wrong with the diagram it was handed -- an
  // envelope that would not project, a layout that failed. That is more
  // specific than anything this function knows, and burying it under a
  // page-level notice would leave the reader with no idea which diagram broke
  // or how.
  it("lets the canvas explain its own broken diagram", () => {
    const input = web({ hasDrawing: false, hasCanvasError: true, inventory: "failed" });

    expect(pageNotice(input)).toBeNull();
  });

  // Except when the view is gone: then the error is about a diagram that no
  // longer exists, and the reader needs to know that first.
  it("still reports an unregistered view over a canvas error", () => {
    const input = web({ hasDrawing: false, hasCanvasError: true, views: [] });

    expect(pageNotice(input)?.kind).toBe("unregistered");
  });

  it("distinguishes a failed listing from an empty one", () => {
    const notice = pageNotice(web({ inventory: "failed", views: [], presentedViewId: null, hasDrawing: false }));

    expect(notice?.kind).toBe("inventory-failed");
    expect(notice?.headline).not.toBe("No diagrams yet.");
  });

  it("distinguishes a lost connection from an empty registry", () => {
    const notice = pageNotice(web({ connection: "lost", views: [], presentedViewId: null, hasDrawing: false }));

    expect(notice?.kind).toBe("disconnected");
    expect(notice?.headline).not.toBe("No diagrams yet.");
  });

  /*
   * "We could not find out what is being shown" is a sixth fact, and it is the
   * one the page used to answer with "Loading...".
   *
   * The bootstrap request is the only thing that tells a freshly opened page
   * what is on screen. If it answers 500 or an unreadable body, nothing ever
   * flips `heardFromHost`, so the page claims something is in progress forever
   * when in truth nothing is. It is not a lost connection either: the server is
   * up and the stream is connected.
   */
  it("says it cannot tell what is presented rather than loading forever", () => {
    const notice = pageNotice(
      web({ bootstrapFailed: true, heardFromHost: false, hasDrawing: false, presentedViewId: null }),
    );

    expect(notice?.kind).toBe("presentation-failed");
    expect(notice?.headline).not.toBe("Loading...");
  });

  it("prefers a lost connection to a failed bootstrap", () => {
    // A server that is down fails bootstrap AND drops the stream. The
    // connection is the more useful sentence: it names the cause.
    const notice = pageNotice(
      web({
        bootstrapFailed: true,
        heardFromHost: false,
        connection: "lost",
        hasDrawing: false,
        presentedViewId: null,
      }),
    );

    expect(notice?.kind).toBe("disconnected");
  });

  it("drops the claim once the host has said something", () => {
    // A failed bootstrap followed by a presentation event on the stream: the
    // page knows what is presented after all, and must stop saying it does not.
    const notice = pageNotice(
      web({
        bootstrapFailed: true,
        heardFromHost: true,
        views: [],
        hasDrawing: false,
        presentedViewId: null,
      }),
    );

    expect(notice?.kind).toBe("no-diagrams");
  });

  it("keeps a drawing on screen despite a failed bootstrap", () => {
    expect(pageNotice(web({ bootstrapFailed: true, heardFromHost: false }))).toBeNull();
  });

  // A lost connection does not erase a diagram that is still legitimately on
  // screen; it is reported alongside it, which is what `staleConnection` is
  // for. Blanking the canvas would trade one false statement for another.
  it("keeps a drawing on screen when the connection drops", () => {
    expect(pageNotice(web({ connection: "lost" }))).toBeNull();
  });

  describe("the MCP shell, which has no inventory to speak of", () => {
    const mcp = (overrides: Partial<PageStateInput> = {}): PageStateInput =>
      web({ mode: "mcp", inventory: "unknown", views: [], ...overrides });

    it("says no diagram is presented, and claims nothing about a registry", () => {
      const notice = pageNotice(mcp({ presentedViewId: null, hasDrawing: false }));

      // It cannot know whether anything is registered, so it does not say.
      expect(notice?.kind).toBe("none-presented");
      expect(notice?.headline).toBe("No diagram presented.");
    });

    it("never reports an empty or stale registry it cannot observe", () => {
      // Nothing registered as far as this shell can see, a view on screen that
      // no inventory backs: none of that is knowable here, so the drawing
      // stands and no claim is made.
      expect(pageNotice(mcp())).toBeNull();
    });

    it("still reports a host connection it has lost", () => {
      expect(pageNotice(mcp({ connection: "lost", hasDrawing: false, presentedViewId: null }))?.kind).toBe(
        "disconnected",
      );
    });
  });
});

it.each(["incompatible", "access-required"] as const)(
  "reports %s on an empty page and retains an existing drawing",
  (connection) => {
    expect(pageNotice(web({ connection, hasDrawing: false }))?.kind).toBe(connection);
    expect(pageNotice(web({ connection, hasDrawing: true }))).toBeNull();
  },
);
