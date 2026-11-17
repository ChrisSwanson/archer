/** Worker parity plus source measurement against the real rendered full-view canvas. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";
import { compile } from "../../../ts/src/mermaid/index";
import { noteDiagrams } from "../../../shared/note-diagrams.mts";
import type { AnalysisResult } from "../../../shared/layout-analysis.mts";
import { sharedTsProject } from "./support/shared-service";
const root = resolve(import.meta.dirname, "../../..");
const kind: Record<string, string> = {
  "sequence-trace": "sequence",
  "state-machine": "state",
  "entity-relationship": "entity-relationship",
  "c4-model": "c4",
  "service-architecture": "architecture",
  "user-journey": "journey",
};
async function envelope(source: string, id: string) {
  const result = await compile(source);
  expect(
    result.diagnostics.filter((d) => d.severity === "error"),
    id,
  ).toEqual([]);
  expect(result.model, id).not.toBeNull();
  return {
    schemaVersion: 2,
    view: { id, kind: kind[result.model!.type] ?? "freeform", title: id },
    revision: `sha256:${"a".repeat(64)}`,
    model: result.model,
  };
}
test("bundled workers agree for all families and heartbeat measurements match the painted full-view canvas", async ({
  page,
}) => {
  const inputs: unknown[] = [];
  for (const family of ["flowchart", "sequence", "state", "er", "c4", "architecture", "journey"]) {
    inputs.push(await envelope(readFileSync(resolve(root, `ts/test/fixtures/${family}/widened.mmd`), "utf8"), family));
  }
  // Pin the LR tour source: another authoring branch changes the example to TB.
  const source = readFileSync(resolve(root, "ts/test/fixtures/layout/heartbeat-lr.mmd"), "utf8");
  const heartbeat = await envelope(source, "heartbeat");
  inputs.push(heartbeat);
  // Production fence extraction, not a test-built envelope transformation.
  const { diagrams: fences } = noteDiagrams(`Intro\n\n\`\`\`mermaid\n%% archer-id: named\n${source}\`\`\`\n`);
  expect(fences).toHaveLength(1);
  inputs.push(await envelope(fences[0].source, "note.md#named"));
  const jobs = inputs.map((envelope) => ({ envelope }));
  jobs.push({
    envelope: heartbeat,
    options: { states: [{ mode: "nested", open: ["showing", "big_picture"] }] },
  } as (typeof jobs)[number]);
  const common = {
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    logLevel: "silent" as const,
    external: ["web-worker"],
  };
  const entry = 'import {analyzeDiagram} from "./ui/src/layout/analysis.ts";';
  const node = await build({
    ...common,
    platform: "node",
    format: "cjs",
    stdin: {
      contents: `${entry} import {parentPort} from "node:worker_threads";parentPort.on("message",async(jobs)=>{try{parentPort.postMessage({results:await Promise.all(jobs.map((j)=>analyzeDiagram(j.envelope,j.options)))});}catch(error){parentPort.postMessage({error:String(error)})}});`,
      resolveDir: root,
    },
  });
  const browser = await build({
    ...common,
    platform: "browser",
    format: "iife",
    stdin: {
      contents: `import "elkjs/lib/elk-worker.min.js"; import {inThreadKernel} from "./ui/src/layout/elk-in-thread.ts"; ${entry} const {kernel}=inThreadKernel(self); self.onmessage=async(event)=>{try{self.postMessage({results:await Promise.all(event.data.map((j)=>analyzeDiagram(j.envelope,j.options,kernel)))});}catch(error){self.postMessage({error:String(error)})}};`,
      resolveDir: root,
    },
  });
  for (const bundle of [node, browser])
    expect(
      Object.keys(bundle.metafile!.inputs).filter((path) => /resvg|export\/svg|export\/painter|react-dom/.test(path)),
    ).toEqual([]);
  const worker = new NodeWorker(node.outputFiles![0].text, { eval: true });
  const expected = new Promise<{ results?: AnalysisResult[]; error?: string }>((accept, reject) => {
    worker.once("message", accept);
    worker.once("error", reject);
  });
  worker.postMessage(jobs);
  const nodeResult = await expected;
  await worker.terminate();
  expect(nodeResult.error).toBeUndefined();
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "heartbeat"\nkind = "freeform"\ntitle = "Heartbeat"\nsource = ".archer/heartbeat.mmd"\n',
      ".archer/heartbeat.mmd": source,
    },
  });
  try {
    await page.route("**/layout-measure-worker.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: browser.outputFiles![0].text }),
    );
    await page.goto(project.url);
    await project.present("heartbeat");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    mkdirSync(resolve(root, ".shots"), { recursive: true });
    await page.screenshot({ path: resolve(root, ".shots/heartbeat-desktop.png") });
    const actual = await page.evaluate(
      (jobs) =>
        new Promise<{ results?: AnalysisResult[]; error?: string }>((accept, reject) => {
          const worker = new Worker(new URL("/layout-measure-worker.js", location.href));
          worker.onmessage = (event) => {
            worker.terminate();
            accept(event.data);
          };
          worker.onerror = (error) => {
            worker.terminate();
            reject(error.message);
          };
          worker.postMessage(jobs);
        }),
      jobs,
    );
    expect(actual.error).toBeUndefined();
    // Numbers are declared at 4 decimals (zooms 5); equality here is stricter than rounding tolerance.
    expect(actual.results).toEqual(nodeResult.results);

    // The public desktop profile is a canvas size, not the whole browser window.
    // Measure the actual canvas and ask Node about precisely that viewport and full-source state.
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    const canvas = await page.locator(".react-flow").evaluate((element) => ({
      width: element.clientWidth,
      height: element.clientHeight,
    }));
    const pageWorker = new NodeWorker(node.outputFiles![0].text, { eval: true });
    const pageResult = new Promise<{ results: AnalysisResult[] }>((accept, reject) => {
      pageWorker.once("message", accept);
      pageWorker.once("error", reject);
    });
    pageWorker.postMessage([{ envelope: heartbeat, options: { states: [{ mode: "full" }], viewport: { canvas } } }]);
    const measured = (await pageResult).results[0].states[0];
    await pageWorker.terminate();
    await expect
      .poll(() =>
        page
          .locator(".react-flow__viewport")
          .evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
      )
      .toBeCloseTo(measured.fitZoom!, 4);
    const rendered = await page.evaluate(
      (groupIds) => {
        const pane = document.querySelector(".react-flow")!.getBoundingClientRect();
        const viewport = document.querySelector(".react-flow__viewport")!;
        const camera = new DOMMatrix(getComputedStyle(viewport).transform);
        const sourceBox = (element: Element) => {
          const box = element.getBoundingClientRect();
          return {
            x: (box.left - pane.left - camera.e) / camera.a,
            y: (box.top - pane.top - camera.f) / camera.a,
            width: box.width / camera.a,
            height: box.height / camera.a,
          };
        };
        const boxes = [
          ...document.querySelectorAll(".react-flow__node, .react-flow__edge-path, .archer-edge-label"),
        ].map(sourceBox);
        const left = Math.min(...boxes.map((box) => box.x));
        const top = Math.min(...boxes.map((box) => box.y));
        return {
          camera: { x: camera.e, y: camera.f, zoom: camera.a },
          minimumTextPxAtFit: Math.min(
            ...[...document.querySelectorAll(".archer-edge-label, .archer-node-label-row, .archer-frame-caption")].map(
              (element) => Number.parseFloat(getComputedStyle(element).fontSize) * camera.a,
            ),
          ),
          bounds: {
            x: left,
            y: top,
            width: Math.max(...boxes.map((box) => box.x + box.width)) - left,
            height: Math.max(...boxes.map((box) => box.y + box.height)) - top,
          },
          groups: groupIds.map((id) => ({
            id,
            ...sourceBox(document.querySelector(`.react-flow__node[data-id="group:${id}"]`)!),
          })),
        };
      },
      measured.groups.map((group) => group.id),
    );
    expect(rendered.minimumTextPxAtFit).toBeCloseTo(measured.minimumTextPxAtFit!, 3);
    // CSS pixels round at the painted edge; 0.05 source px admits that, not layout drift.
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(rendered.bounds[key], `painted content ${key}`).toBeCloseTo(measured.bounds[key], 1);
      for (const [index, group] of measured.groups.entries())
        expect(rendered.groups[index][key], `painted ${group.id} ${key}`).toBeCloseTo(group[key], 1);
    }
    writeFileSync(
      resolve(root, ".shots/layout-measurement-parity.json"),
      JSON.stringify({ browser: page.viewportSize(), canvas, state: "full", measured, rendered }, null, 2),
    );
    await page.screenshot({ path: resolve(root, ".shots/layout-measurement-parity.png") });
  } finally {
    await project.stop();
  }
});
