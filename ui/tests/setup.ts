// Vitest setup. Runs for every test file; the DOM-specific parts are skipped
// in the default `node` environment and only apply to files that opt in with
// `// @vitest-environment jsdom`.

import { vi } from "vitest";

// jsdom cannot run a browser Worker. Component tests invoke the same pure
// production layout core through this boundary; real-browser worker tests
// verify the actual transport, host policy and returned geometry separately.
vi.mock("../src/layout/elk-worker-transport", () => ({
  // The view and face only: a third argument here is the transport's request options, not an engine.
  computeBackgroundLayout: async (
    ...[view, typeface]: Parameters<typeof import("../src/layout/elk-adapter").computeLayout>
  ) => {
    const { computeLayout } = await import("../src/layout/elk-adapter");
    return computeLayout(view, typeface);
  },
  // Starting the worker ahead (the inventory names a graph) has no worker to start here.
  startBackgroundLayout: () => undefined,
}));

if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest");
  // jsdom has no Web Locks; the tab-ownership rule (draft-tabs.ts) reads open tabs from them.
  (await import("./support/fake-locks")).installFakeLocks();

  // A timeout is a ceiling, not a wait: a passing test never reaches it.
  // Testing Library gives `waitFor` and `findBy` one second by default, and
  // the first test of a file pays for ELK starting up. On a busy machine that
  // took longer than a second, and `keyboard-shortcuts.test.tsx` failed with
  // "expected 0 to be 2" in one run of three under load (2026-10-01,
  // `scripts/repeat-suite.mjs`). Vitest's own limit is raised to match in
  // `vite.config.ts`, or the test would time out before the wait did.
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: 10_000 });

  // jsdom has no layout, and its Range has no geometry. CodeMirror measures text through
  // Range.getClientRects in an animation frame; one landing after a test finished threw an
  // uncaught TypeError that failed the whole run (source-panel-editor.test.tsx, under load).
  const emptyRect = (): DOMRect =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) }) as DOMRect;
  if (typeof Range !== "undefined") {
    Range.prototype.getClientRects ??= function getClientRects() {
      return Object.assign([], { item: () => null }) as unknown as DOMRectList;
    };
    Range.prototype.getBoundingClientRect ??= emptyRect;
  }

  // The project catalog is remembered per fetcher for the life of a page; a test
  // file is one page, so forget it between tests. So is its address, which the
  // page writes as the reader moves (`page-address.ts`): each test opens bare.
  {
    const { afterEach } = await import("vitest");
    const { forgetProjectCatalogs } = await import("../src/app/project-directory");
    const { resources } = await import("../src/app/resources");
    afterEach(() => {
      forgetProjectCatalogs();
      resources.forget();
      window.history.replaceState(null, "", "/");
    });
  }

  // jsdom lacks the browser APIs @xyflow/react touches while rendering.
  //
  // The stub reports an observation as soon as an element is observed: react-flow
  // only renders edges once its nodes have been measured, and jsdom never fires
  // a real resize.
  if (typeof globalThis.ResizeObserver === "undefined") {
    class ResizeObserverStub {
      constructor(private readonly callback: ResizeObserverCallback) {}

      observe(target: Element): void {
        setTimeout(() => this.emit(target), 0);
      }

      private emit(target: Element): void {
        const rect = target.getBoundingClientRect();
        const entry = {
          target,
          contentRect: rect,
          borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
          devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
        } as unknown as ResizeObserverEntry;
        this.callback([entry], this as unknown as ResizeObserver);
      }

      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  }

  // jsdom implements no SVG layout, so `getBBox` is missing entirely.
  // React Flow's `EdgeText` calls it to size the label background and throws
  // without it, which takes down the whole edge -- label and path.
  if (typeof SVGElement !== "undefined" && !("getBBox" in SVGElement.prototype)) {
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value(this: SVGElement): DOMRect {
        const rect = this.getBoundingClientRect();
        return rect;
      },
    });
  }

  // jsdom implements no pointer events at all -- there is no `PointerEvent`
  // constructor, so Testing Library falls back to a bare `Event` and every
  // pointer property arrives as `undefined`. React Flow starts a marquee only
  // for `event.button === 0 && event.isPrimary`, so without this the marquee
  // path cannot be exercised at all.
  //
  // Modelled on the real interface: `PointerEvent extends MouseEvent`, so the
  // coordinate and button semantics are jsdom's own and only the pointer-
  // specific fields are added here.
  if (typeof globalThis.PointerEvent === "undefined") {
    class PointerEventStub extends MouseEvent {
      readonly pointerId: number;
      readonly isPrimary: boolean;
      readonly pointerType: string;

      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
        this.isPrimary = params.isPrimary ?? false;
        this.pointerType = params.pointerType ?? "mouse";
      }
    }
    // Testing Library reads the constructor off `window`, React Flow off the
    // global scope; in jsdom these are the same object but typed differently.
    globalThis.PointerEvent = PointerEventStub as unknown as typeof PointerEvent;
    (window as unknown as Record<string, unknown>).PointerEvent = PointerEventStub;
  }

  // Pointer capture redirects later events for a pointer to one element. Every
  // consumer here observes events on that element anyway, so capture is a no-op
  // rather than a behaviour the tests depend on.
  for (const method of ["setPointerCapture", "releasePointerCapture"] as const) {
    if (!(method in Element.prototype)) {
      Object.defineProperty(Element.prototype, method, {
        configurable: true,
        value(): void {},
      });
    }
  }
  if (!("hasPointerCapture" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "hasPointerCapture", {
      configurable: true,
      value(): boolean {
        return false;
      },
    });
  }

  if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
    class DOMMatrixReadOnlyStub {
      m22 = 1;
    }
    globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;
  }

  // jsdom reports zero-sized boxes, which makes react-flow treat the canvas as
  // having no viewport. Fall back to the element's inline size, or a nominal
  // viewport, so nodes are actually mounted.
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const rect = originalGetBoundingClientRect.call(this);
    if (rect.width !== 0 || rect.height !== 0) {
      return rect;
    }
    const style = (this as HTMLElement).style as CSSStyleDeclaration | undefined;
    const width = Number.parseFloat(style?.width ?? "") || 800;
    const height = Number.parseFloat(style?.height ?? "") || 600;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  };

  // jsdom never lays out, so `offsetWidth`/`offsetHeight` are always 0.
  // react-flow reads them to decide whether a node has been measured, and
  // refuses to render edges for unmeasured nodes. Fall back to inline size.
  for (const prop of ["offsetWidth", "offsetHeight"] as const) {
    const axis = prop === "offsetWidth" ? "width" : "height";
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement): number {
        return Number.parseFloat(this.style[axis]) || 0;
      },
    });
  }
}
