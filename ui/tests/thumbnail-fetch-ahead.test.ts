// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetPrefetchedThumbnails,
  prefetchServiceThumbnails,
  serviceThumbnailUrl,
  THUMBNAIL_PREFETCH_LIMIT,
} from "../src/app/document-previews";
import { forgetThumbnailVersion, rememberThumbnailVersion } from "../src/app/thumbnail-version";
import {
  FETCH_AHEAD_LIMIT,
  fetchThumbnailsAhead,
  forgetThumbnailFetchAhead,
  GALLERY_INTENT,
  whenGalleryWanted,
  type FetchAheadEnvironment,
  type FetchAheadProject,
} from "../src/app/thumbnail-fetch-ahead";
import { DEFAULT_PROJECT_LIFECYCLE } from "../src/app/project-lifecycle";

const rev = (n: number): string => `sha256:${n.toString(16).padStart(64, "0")}`;
const project = (slug: string, count: number, extra: Partial<FetchAheadProject> = {}): FetchAheadProject => ({
  slug,
  lifecycle: DEFAULT_PROJECT_LIFECYCLE,
  views: Array.from({ length: count }, (_, i) => ({
    id: `${slug}-v${i}`,
    registration: "durable",
    modelRevision: rev(i + 1),
  })),
  ...extra,
});
const BASE = "https://archer.example/projects/";
const currentUrlOf = (slug: string, id: string, n: number): string | null =>
  serviceThumbnailUrl(
    { kind: "diagram", failing: false, slug, current: true, id, modelRevision: rev(n) } as never,
    BASE,
    "light",
  );

/** A scripted page: the test says when it is idle and when each image answers. */
function scriptedPage(overrides: Partial<FetchAheadEnvironment> = {}) {
  const settled: (() => void)[] = [];
  const idle: (() => void)[] = [];
  const visible: (() => void)[] = [];
  const online: (() => void)[] = [];
  const loads: { url: string; priority: string; done: (ok: boolean) => void }[] = [];
  const storage = new Map<string, string>();
  let hidden = false;
  let offline = false;
  let editing = false;
  let tick = 0;
  const env: FetchAheadEnvironment = {
    // The reader has reached for the gallery already, unless a test says otherwise.
    whenWanted: (run) => {
      run();
      return () => undefined;
    },
    whenSettled: (run) => {
      settled.push(run);
      return () => undefined;
    },
    whenIdle: (run) => {
      idle.push(run);
      return () => undefined;
    },
    onVisible: (run) => {
      visible.push(run);
      return () => undefined;
    },
    hidden: () => hidden,
    offline: () => offline,
    onOnline: (run) => {
      online.push(run);
      return () => undefined;
    },
    saveData: () => false,
    smallScreen: () => false,
    embedded: () => false,
    editing: () => editing,
    now: () => (tick += 1000),
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
    load: (url, priority) => new Promise<boolean>((done) => loads.push({ url, priority, done })),
    ...overrides,
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  return {
    env,
    loads,
    storage,
    setHidden: (value: boolean) => {
      hidden = value;
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
    reconnect: async () => {
      online.splice(0).forEach((run) => run());
      await flush();
    },
    setEditing: (value: boolean) => {
      editing = value;
    },
    settle: async () => {
      settled.splice(0).forEach((run) => run());
      await flush();
    },
    idle: async () => {
      idle.splice(0).forEach((run) => run());
      await flush();
    },
    show: async () => {
      visible.splice(0).forEach((run) => run());
      await flush();
    },
    answer: async (ok = true) => {
      const open = loads.filter((l) => !(l as { answered?: boolean }).answered);
      for (const l of open) {
        (l as { answered?: boolean }).answered = true;
        l.done(ok);
      }
      await flush();
    },
    /** Runs idle callbacks and answers images until nothing more is asked. */
    drain: async function (this: void) {
      for (let i = 0; i < 400; i++) {
        if (idle.length === 0 && loads.every((l) => (l as { answered?: boolean }).answered)) return;
        idle.splice(0).forEach((run) => run());
        await flush();
        for (const l of loads)
          if (!(l as { answered?: boolean }).answered) {
            (l as { answered?: boolean }).answered = true;
            l.done(true);
          }
        await flush();
      }
    },
  };
}

beforeEach(() => {
  forgetPrefetchedThumbnails();
  forgetThumbnailFetchAhead();
  rememberThumbnailVersion("00ff");
});
afterEach(() => {
  forgetThumbnailVersion();
});

describe("fetchThumbnailsAhead", () => {
  it("asks for nothing, settled and idle, until the reader reaches for the gallery (PF-4)", async () => {
    const wanted: (() => void)[] = [];
    const page = scriptedPage({
      whenWanted: (run) => {
        wanted.push(run);
        return () => undefined;
      },
    });
    fetchThumbnailsAhead([project("alpha", 2)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    await page.settle();
    await page.drain();
    expect(page.loads).toHaveLength(0);
    // A newer catalog does not start it either, nor wait twice.
    fetchThumbnailsAhead([project("alpha", 3)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    expect(wanted).toHaveLength(1);
    wanted.splice(0).forEach((run) => run());
    await page.settle();
    await page.drain();
    expect(page.loads.map((l) => l.url)).toEqual([1, 2, 3].map((n) => currentUrlOf("alpha", `alpha-v${n - 1}`, n)));
  });

  it("asks for nothing until the page has settled and is idle, then for the current project's cards at low priority", async () => {
    const page = scriptedPage();
    fetchThumbnailsAhead([project("alpha", 2), project("beta", 1)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    expect(page.loads).toHaveLength(0);
    await page.idle();
    expect(page.loads).toHaveLength(0);
    await page.settle();
    expect(page.loads).toHaveLength(0);
    await page.drain();
    expect(page.loads.map((l) => l.url)).toEqual([
      currentUrlOf("alpha", "alpha-v0", 1),
      currentUrlOf("alpha", "alpha-v1", 2),
    ]);
    expect(new Set(page.loads.map((l) => l.priority))).toEqual(new Set(["low"]));
  });

  it("keeps at most two in flight", async () => {
    const page = scriptedPage();
    fetchThumbnailsAhead([project("alpha", 6)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    await page.settle();
    for (let i = 0; i < 6; i++) await page.idle();
    expect(page.loads).toHaveLength(2);
    await page.answer();
    for (let i = 0; i < 6; i++) await page.idle();
    expect(page.loads).toHaveLength(4);
  });

  it("paces its asks so the service never sees a burst from it", async () => {
    let clock = 0;
    const page = scriptedPage({ now: () => clock });
    fetchThumbnailsAhead([project("alpha", 10)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    await page.settle();
    await page.drain();
    // The clock never moved: only the first ask may start; the rest wait for time to pass.
    expect(page.loads).toHaveLength(1);
    for (let i = 0; i < 40 && page.loads.length < 10; i++) {
      clock += 50;
      await page.drain();
    }
    expect(page.loads).toHaveLength(10);
    // 40 starts per 5 s at most (svc.request-burst is 60 per 5 s, for every request the client makes).
    expect(clock).toBeGreaterThanOrEqual((9 * 5000) / 40);
  });

  it("asks only for the current project's first screen of cards: never another project's", async () => {
    const page = scriptedPage();
    fetchThumbnailsAhead([project("alpha", THUMBNAIL_PREFETCH_LIMIT + 10), project("beta", 5)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    await page.settle();
    await page.drain();
    expect(FETCH_AHEAD_LIMIT).toBeLessThan(THUMBNAIL_PREFETCH_LIMIT);
    expect(page.loads.map((l) => l.url)).toEqual(
      Array.from({ length: FETCH_AHEAD_LIMIT }, (_, i) => currentUrlOf("alpha", `alpha-v${i}`, i + 1)),
    );
  });

  it("asks for nothing without a current project, or when the current project is archived", async () => {
    for (const [projects, currentSlug] of [
      [[project("alpha", 3)], null],
      [[project("alpha", 3, { lifecycle: { state: "inactive", visibility: "hidden" } })], "alpha"],
    ] as const) {
      forgetPrefetchedThumbnails();
      forgetThumbnailFetchAhead();
      const page = scriptedPage();
      fetchThumbnailsAhead(projects, { baseUrl: BASE, theme: "light", currentSlug, environment: page.env });
      await page.settle();
      await page.drain();
      expect(page.loads).toHaveLength(0);
    }
  });

  it("asks for an embedded diagram's thumbnail like any other, and skips an uncompiled one", async () => {
    const page = scriptedPage();
    const mixed = project("beta", 1);
    fetchThumbnailsAhead(
      [
        {
          ...mixed,
          views: [
            ...mixed.views,
            { id: "notes/a.md#x", registration: "embedded", modelRevision: rev(9) },
            { id: "broken", registration: "durable" },
          ],
        },
      ],
      { baseUrl: BASE, theme: "light", currentSlug: "beta", environment: page.env },
    );
    await page.settle();
    await page.drain();
    expect(page.loads.map((l) => l.url)).toEqual([
      currentUrlOf("beta", "beta-v0", 1),
      currentUrlOf("beta", "notes/a.md#x", 9),
    ]);
  });

  it("never asks for more than FETCH_AHEAD_LIMIT on one page, however often the catalog changes", async () => {
    const page = scriptedPage();
    for (let round = 0; round < 5; round++) {
      const next = project("alpha", FETCH_AHEAD_LIMIT);
      fetchThumbnailsAhead(
        [{ ...next, views: next.views.map((view, i) => ({ ...view, modelRevision: rev(100 * round + i + 1) })) }],
        { baseUrl: BASE, theme: "light", currentSlug: "alpha", environment: page.env },
      );
      await page.settle();
      await page.drain();
    }
    expect(page.loads).toHaveLength(FETCH_AHEAD_LIMIT);
  });

  it("never asks twice for what the Diagrams tab's prefetch asked for", async () => {
    const page = scriptedPage();
    const href = "https://archer.example/projects/beta/?tab=diagrams";
    prefetchServiceThumbnails(project("beta", 2).views, new Set(), "beta", href, "light");
    fetchThumbnailsAhead([project("alpha", 1), project("beta", 3)], {
      baseUrl: href,
      theme: "light",
      currentSlug: "beta",
      environment: page.env,
    });
    await page.settle();
    await page.drain();
    expect(page.loads.map((l) => l.url)).toEqual([
      serviceThumbnailUrl(
        { kind: "diagram", failing: false, slug: "beta", current: true, id: "beta-v2", modelRevision: rev(3) } as never,
        href,
        "light",
      ),
    ]);
  });

  it("asks once per browser session per project and revision set; a changed diagram is asked for again", async () => {
    const first = scriptedPage();
    fetchThumbnailsAhead([project("alpha", 2)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: first.env,
    });
    await first.settle();
    await first.drain();
    expect(first.loads).toHaveLength(2);
    // A new page in the same session (same sessionStorage), with the in-page memory gone.
    forgetPrefetchedThumbnails();
    forgetThumbnailFetchAhead();
    const second = scriptedPage({ storage: first.env.storage });
    fetchThumbnailsAhead([project("alpha", 2)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: second.env,
    });
    await second.settle();
    await second.drain();
    expect(second.loads).toHaveLength(0);
    const changed = project("alpha", 2);
    fetchThumbnailsAhead(
      [{ ...changed, views: [changed.views[0]!, { ...changed.views[1]!, modelRevision: rev(77) }] }],
      { baseUrl: BASE, theme: "light", currentSlug: "alpha", environment: second.env },
    );
    await second.settle();
    await second.drain();
    expect(second.loads.map((l) => l.url)).toEqual([currentUrlOf("alpha", "alpha-v1", 77)]);
  });

  it("does nothing in the MCP host embed, with Save-Data, on a touch or narrow screen, or without the service's thumbnail version", async () => {
    for (const overrides of [{ embedded: () => true }, { saveData: () => true }, { smallScreen: () => true }]) {
      const page = scriptedPage(overrides);
      fetchThumbnailsAhead([project("alpha", 2)], {
        baseUrl: BASE,
        theme: "light",
        currentSlug: "alpha",
        environment: page.env,
      });
      await page.settle();
      await page.drain();
      expect(page.loads).toHaveLength(0);
    }
    forgetThumbnailVersion();
    const page = scriptedPage();
    fetchThumbnailsAhead([project("alpha", 2)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    await page.settle();
    await page.drain();
    expect(page.loads).toHaveLength(0);
  });

  it("asks for nothing while the page is an editor, and carries on once it reads again", async () => {
    const page = scriptedPage();
    page.setEditing(true);
    fetchThumbnailsAhead([project("alpha", 2), project("beta", 2)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    await page.settle();
    for (let i = 0; i < 5; i++) await page.idle();
    expect(page.loads).toHaveLength(0);
    page.setEditing(false);
    await page.drain();
    expect(page.loads).toHaveLength(2);
  });

  it("waits while the page is hidden and carries on when it is shown again", async () => {
    const page = scriptedPage();
    page.setHidden(true);
    fetchThumbnailsAhead([project("alpha", 2)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    await page.settle();
    await page.drain();
    expect(page.loads).toHaveLength(0);
    page.setHidden(false);
    await page.show();
    await page.settle();
    await page.drain();
    expect(page.loads).toHaveLength(2);
  });

  it("asks for nothing while the browser is offline, and carries on once it is back online", async () => {
    // An ask sent offline fails, logs a console error and spends the address for this page (claimed).
    const page = scriptedPage();
    fetchThumbnailsAhead([project("alpha", 2)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    page.setOffline(true);
    await page.settle();
    await page.drain();
    expect(page.loads).toHaveLength(0);
    page.setOffline(false);
    await page.reconnect();
    await page.settle();
    await page.drain();
    expect(page.loads.map((l) => l.url)).toEqual([
      currentUrlOf("alpha", "alpha-v0", 1),
      currentUrlOf("alpha", "alpha-v1", 2),
    ]);
  });

  it("a failed image is not marked done for the session, so a later page may ask again", async () => {
    const page = scriptedPage();
    fetchThumbnailsAhead([project("alpha", 1)], {
      baseUrl: BASE,
      theme: "light",
      currentSlug: "alpha",
      environment: page.env,
    });
    await page.settle();
    await page.idle();
    await page.answer(false);
    expect([...page.storage.keys()]).toEqual([]);
  });
});

describe("fetchThumbnailsAhead in the browser", () => {
  const created: string[] = [];
  class RecordingImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = "";
    fetchPriority = "";
    set src(url: string) {
      created.push(url);
    }
  }
  const matchMedia = (matches: (query: string) => boolean) => (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });

  beforeEach(() => {
    created.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("Image", RecordingImage);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function run(): Promise<void> {
    document.body.innerHTML = `<button role="tab" ${GALLERY_INTENT}>Diagrams</button>`;
    fetchThumbnailsAhead([project("alpha", 3)], { baseUrl: BASE, theme: "light", currentSlug: "alpha" });
    await vi.advanceTimersByTimeAsync(20_000);
    // Nothing until the reader points at the Diagrams tab.
    expect(created).toHaveLength(0);
    document.querySelector("button")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(20_000);
  }

  it("asks on a fine pointer and a wide screen", async () => {
    vi.stubGlobal(
      "matchMedia",
      matchMedia(() => false),
    );
    await run();
    expect(created).toHaveLength(3);
  });

  it.each([
    ["a coarse pointer", (query: string) => query.includes("pointer: coarse")],
    ["a screen under 600px", (query: string) => query.includes("max-width")],
  ])("asks for nothing on %s", async (_label, matches) => {
    vi.stubGlobal("matchMedia", matchMedia(matches));
    await run();
    expect(created).toHaveLength(0);
  });
});

describe("whenGalleryWanted", () => {
  it("runs once a pointer comes over or focus lands on a control that opens the gallery, and only then (PF-4)", () => {
    document.body.innerHTML = `<button id="other">Notes</button><button id="tab" ${GALLERY_INTENT}><span id="count">3</span></button>`;
    const run = vi.fn();
    const stop = whenGalleryWanted(document, run);
    document.getElementById("other")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    document.getElementById("other")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(run).not.toHaveBeenCalled();
    document.getElementById("count")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    document.getElementById("tab")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("can be called off before the reader reaches", () => {
    document.body.innerHTML = `<button id="tab" ${GALLERY_INTENT}>Diagrams</button>`;
    const run = vi.fn();
    whenGalleryWanted(document, run)();
    document.getElementById("tab")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(run).not.toHaveBeenCalled();
  });
});
