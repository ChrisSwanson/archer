/** Real native worker in the embedded bundle; exact geometry comes from the same production core. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { sharedTsProject } from "./support/shared-service";

/**
 * One label per family made much longer: a change of geometry, so the page must lay the drawing out
 * again (a small change inside a box's minimum width is the same ELK graph, served from the cache).
 */
const RELABEL: Record<string, readonly [string, string]> = {
  flowchart: ["([Client])", "([Client application, renamed])"],
  state: ['"Waiting for work"', '"Waiting for more work"'],
  er: ['["Customer"]', '["Customer account, renamed"]'],
  c4: ['"Customer", "Buys things"', '"Customer account, renamed", "Buys things"'],
  architecture: ["service client[Client]", "service client[Client application, renamed]"],
};
for (const [family, kind] of [
  ["flowchart", "freeform"],
  ["state", "state"],
  ["er", "entity-relationship"],
  ["c4", "c4"],
  ["architecture", "architecture"],
]) {
  test(`${family}: native worker keeps exact production geometry and is reused`, async ({ page }) => {
    await page.addInitScript(() => {
      const native = window.Worker;
      const observed = {
        created: 0,
        requests: [] as unknown[],
        results: [] as unknown[],
        mainTasks: 0,
        mainTasksAtResult: [] as number[],
      };
      (window as unknown as { workerObserved: typeof observed }).workerObserved = observed;
      window.Worker = class extends native {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          observed.created++;
          this.addEventListener("message", (event) => {
            observed.mainTasksAtResult.push(observed.mainTasks);
            observed.results.push(event.data);
          });
        }
        postMessage(message: unknown) {
          observed.requests.push(message);
          // A main-thread task queued before dispatch completes while the real
          // worker owns layout. This uses conditions, never a sleep/time threshold.
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            observed.mainTasks++;
            channel.port1.close();
            channel.port2.close();
          };
          channel.port2.postMessage(null);
          super.postMessage(message);
        }
      };
    });
    const source = readFileSync(
      resolve(import.meta.dirname, `../../../ts/test/fixtures/${family}/widened.mmd`),
      "utf8",
    );
    const project = await sharedTsProject({
      files: {
        // The full view: this pins ELK's own path. The nested view's layouts go through the nest
        // channel of the same worker (the "nest" case below).
        "archer.toml": `version = 1\nnested_view = false\n[[views]]\nid = "drawing"\nkind = "${kind}"\ntitle = "Worker"\nsource = ".archer/drawing.mmd"\n`,
        ".archer/drawing.mmd": source,
      },
    });
    try {
      await page.goto(project.url);
      await project.present("drawing");
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      const observed = () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                workerObserved: {
                  created: number;
                  requests: { id: number; cmd: string; graph: ElkNode; options?: object }[];
                  results: { id: number; data?: ElkNode }[];
                  mainTasks: number;
                  mainTasksAtResult: number[];
                };
              }
            ).workerObserved,
        );
      await expect.poll(async () => (await observed()).results.length).toBeGreaterThan(0);
      const first = await observed();
      // Compare the exact production graph/options dispatched to the official
      // worker with the same real ELK kernel locally. No test graph conversion.
      const request = first.requests.find((request) => request.cmd === "layout")!;
      expect(request).toBeDefined();
      const index = first.results.findIndex((result) => result.id === request.id);
      expect(index).toBeGreaterThanOrEqual(0);
      const expected = await new ELK().layout(request.graph, request.options);
      expect(first.created).toBe(1);
      expect(first.mainTasksAtResult[index]).toBeGreaterThan(0);
      // GWT emits a private runtime object-hash counter, whose value depends
      // on prior layouts in that process. It is not geometry or a stable ID.
      const withoutRuntimeHash = (value: unknown): unknown =>
        JSON.parse(JSON.stringify(value, (key, field) => (key === "$H" ? undefined : field)));
      expect(withoutRuntimeHash(first.results[index]?.data)).toEqual(withoutRuntimeHash(expected));
      // A comment-only write keeps the geometry, and the page reuses its layout without asking
      // the worker (layout cache by geometry): only a changed drawing shows the worker is reused.
      const [find, replace] = RELABEL[family]!;
      expect(source).toContain(find);
      await project.agentWrite("drawing", ".archer/drawing.mmd", source.replace(find, replace));
      // Reuse, not latency, is under test: the relayout goes through the service's
      // write, event and compile, which a loaded CI host can stretch past 10s.
      await expect
        .poll(async () => (await observed()).results.length, { timeout: 30_000 })
        .toBeGreaterThan(first.results.length);
      expect((await observed()).created).toBe(1);
    } finally {
      await project.stop();
    }
  });
}

test("blocked worker startup shows an error, retains the last drawing and recovers", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const native = window.Worker;
    (window as unknown as { blockLayoutWorker: boolean }).blockLayoutWorker = false;
    window.Worker = class extends native {
      constructor(url: string | URL, options?: WorkerOptions) {
        if ((window as unknown as { blockLayoutWorker: boolean }).blockLayoutWorker)
          throw new DOMException("Worker policy refused", "SecurityError");
        super(url, options);
      }
    };
  });
  const source = "flowchart LR\n a[Client]\n b[API]\n a hop@--> b\n";
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Worker"\nsource = ".archer/drawing.mmd"\n',
      ".archer/drawing.mmd": source,
    },
  });
  try {
    await page.goto(project.url);
    await project.present("drawing");
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { blockLayoutWorker: boolean }).blockLayoutWorker = true;
      // pagehide closes the worker; until pageshow a leaving page starts no new layout (O23), so the
      // page "comes back" to make the next layout start a fresh worker, which the policy refuses.
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      window.dispatchEvent(new PageTransitionEvent("pageshow"));
    });
    // A changed drawing: a comment-only write would reuse the layout and never ask for a worker.
    await project.agentWrite("drawing", ".archer/drawing.mmd", source.replace("Client", "Policy test"));
    const refused = page.getByText(
      "Background layout could not start. Reload the page (Archer may have been updated since it loaded).",
    );
    await expect(refused).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Layout could not start" })).toBeVisible();
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    expect(pageErrors).toEqual([]);
    await page.evaluate(() => {
      (window as unknown as { blockLayoutWorker: boolean }).blockLayoutWorker = false;
    });
    await project.agentWrite(
      "drawing",
      ".archer/drawing.mmd",
      source.replace("Client", "Recovered") + "\n%% recovered\n",
    );
    await expect(page.locator('.react-flow__node[data-id="a"]')).toContainText("Recovered");
    await expect(refused).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Layout could not start" })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await project.stop();
  }
});

test("the nested view's engine answers in the page's worker: a press sends its first picture, then the routed one", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const native = window.Worker;
    const made: Worker[] = [];
    (window as unknown as { layoutWorkers: Worker[] }).layoutWorkers = made;
    window.Worker = class extends native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        made.push(this);
      }
    };
  });
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Worker"\nsource = ".archer/drawing.mmd"\n',
      ".archer/drawing.mmd": "flowchart LR\n a[Client]\n b[API]\n a hop@--> b\n",
    },
  });
  try {
    await page.goto(project.url);
    await project.present("drawing");
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    // The worker the page made, asked directly in the nest protocol (nest-protocol.ts): the
    // production entry, its dispatcher and its in-thread ELK, with no page code in between.
    const replies = await page.evaluate(async () => {
      const worker = (window as unknown as { layoutWorkers: Worker[] }).layoutWorkers[0]!;
      const full = {
        viewId: "nest",
        kind: "flowchart",
        title: "nest",
        revision: "e2e",
        modelType: "freeform-graph",
        direction: "tb",
        nodes: [
          { id: "client", label: "Client", shape: "rectangle", classes: [] },
          { id: "api", label: "API", shape: "rectangle", classes: [], groupId: "svc" },
          { id: "db", label: "Store", shape: "cylinder", classes: [], groupId: "svc" },
        ],
        edges: [
          { id: "calls", source: "client", target: "api", label: "calls" },
          { id: "reads", source: "api", target: "db" },
        ],
        groups: [{ id: "svc", label: "Service" }],
      };
      const spec = { full, typeface: "fira", revision: "e2e" };
      const ask = (id: number, message: object) =>
        new Promise<{ kind: string; how?: string; layout?: { nodes: { id: string }[]; groups: { id: string }[] } }[]>(
          (resolve) => {
            const got: {
              kind: string;
              how?: string;
              layout?: { nodes: { id: string }[]; groups: { id: string }[] };
            }[] = [];
            const listen = (event: MessageEvent) => {
              const reply = (
                event.data as {
                  nest?: {
                    id: number;
                    kind: string;
                    how?: string;
                    layout?: { nodes: { id: string }[]; groups: { id: string }[] };
                  };
                }
              ).nest;
              if (reply?.id !== id) return;
              got.push(reply);
              if (reply.kind !== "first") {
                worker.removeEventListener("message", listen);
                resolve(got);
              }
            };
            worker.addEventListener("message", listen);
            worker.postMessage({ nest: { id, session: { key: "e2e", spec }, ...message } });
          },
        );
      const base = await ask(900001, { op: "layout", open: [] });
      const press = await ask(900002, { op: "layout", open: ["svc"], step: { from: [], toggled: "svc" } });
      return { base, press };
    });
    expect(replies.base.map((reply) => [reply.kind, reply.how])).toEqual([["complete", "base"]]);
    expect(replies.press.map((reply) => [reply.kind, reply.how])).toEqual([
      ["first", undefined],
      ["complete", "grow"],
    ]);
    const complete = replies.press[1]!.layout!;
    expect(complete.nodes.map((node) => node.id).sort()).toEqual(["api", "client", "db"]);
    expect(complete.groups.map((group) => group.id)).toEqual(["svc"]);
    // ELK's own messages still reach the page's drawing.
    await project.agentWrite("drawing", ".archer/drawing.mmd", "flowchart LR\n a[Recovered]\n b[API]\n a hop@--> b\n");
    await expect(page.locator('.react-flow__node[data-id="a"]')).toContainText("Recovered");
  } finally {
    await project.stop();
  }
});

const DRAWING = {
  "archer.toml":
    'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Worker"\nsource = ".archer/drawing.mmd"\n',
  ".archer/drawing.mmd": "flowchart LR\n a[Client]\n b[API]\n a hop@--> b\n",
  ".archer/notes/words.md": "---\nauthor: agent\n---\n# Words\n\nA note of text alone, with no figure to lay out.\n",
};

test("ELK loads only for a graph: a note of text never fetches it; a diagram fetches its own file once, under the page's cookie", async ({
  page,
}) => {
  const asked: { url: string; status: number; type: string | undefined; cache: string | undefined }[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/page-assets/"))
      asked.push({
        url: new URL(response.url()).pathname,
        status: response.status(),
        type: response.headers()["content-type"],
        cache: response.headers()["cache-control"],
      });
  });
  await page.addInitScript(() => {
    const native = window.Worker;
    (window as unknown as { workersMade: number }).workersMade = 0;
    window.Worker = class extends native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (window as unknown as { workersMade: number }).workersMade++;
      }
    };
  });
  const project = await sharedTsProject({ files: DRAWING });
  try {
    // The agent's link lands on the follow page, which may draw (and so starts ELK): count from the note on.
    await page.goto(project.url);
    await page.waitForLoadState("networkidle");
    asked.length = 0;
    await page.goto(new URL("notes/words.md", page.url()).href);
    await expect(page.getByText("A note of text alone, with no figure to lay out.")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => (window as unknown as { workersMade: number }).workersMade)).toBe(0);
    expect(asked).toEqual([]);
    await page.goto(project.url);
    await project.present("drawing");
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    expect(asked).toEqual([
      {
        url: expect.stringMatching(/^\/-\/page-assets\/elk-layout-worker-[\w-]+\.js$/),
        status: 200,
        type: "text/javascript; charset=utf-8",
        cache: "private, max-age=31536000, immutable",
      },
    ]);
  } finally {
    await project.stop();
  }
});

test("a page whose worker cannot start (its file is gone, say) says to reload, and the shell announces it with Reload", async ({
  page,
}) => {
  await page.route("**/-/page-assets/**", (route) => route.fulfill({ status: 404, body: "" }));
  const project = await sharedTsProject({ files: DRAWING });
  try {
    await page.goto(project.url);
    await project.present("drawing");
    await expect(
      page.getByText(
        "Background layout could not start. Reload the page (Archer may have been updated since it loaded).",
      ),
    ).toBeVisible();
    const cue = page.getByRole("status").filter({ hasText: "Layout could not start" });
    await expect(cue.getByRole("button", { name: "Reload" })).toBeVisible();
  } finally {
    await project.stop();
  }
});
