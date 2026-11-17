// Stopping while PNG thumbnails draw lets the process exit (server review S3: the pid stayed
// alive minutes after "service: stopped"). Two causes: an unref'd worker was ref'd again by the
// listeners attached after `unref()`, and a request still waiting for a drawing slot was let in
// after close and started a fresh worker. Run in a child process, since the question is whether
// a process exits.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const src = (path: string) => pathToFileURL(resolve("src", path)).href;

test("closing the store and painters while PNGs draw and wait lets the process exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archer-thumb-stop-"));
  dirs.push(dir);
  const script = join(dir, "stop.mts");
  writeFileSync(
    script,
    `
import { readFileSync } from "node:fs";
import { compile } from ${JSON.stringify(src("mermaid/index.ts"))};
import { ThumbnailPainters, ThumbnailStore } from ${JSON.stringify(src("service/thumbnails.ts"))};
const root = ${JSON.stringify(resolve(".."))};
const raster = { fontFaces: [{ weight: 400, style: "normal", bytes: readFileSync(root + "/ui/src/theme/fonts/fira-sans-latin-400.woff2") }], wasmBytes: readFileSync(root + "/node_modules/@resvg/resvg-wasm/index_bg.wasm") };
const painters = new ThumbnailPainters({ themeCss: () => readFileSync(root + "/ui/src/styles.css", "utf8"), raster: () => raster, workers: 2 });
const store = new ThumbnailStore({ dir: ${JSON.stringify(join(dir, "cache"))}, render: painters.render, format: "png", concurrency: 2, queue: 16, timeoutMs: 60_000 });
const lines = ["flowchart TD"];
for (let i = 0; i <= 80; i++) lines.push("  n" + i + '["Step ' + i + '"]');
for (let i = 0; i < 80; i++) lines.push("  n" + i + " e" + i + "@--> n" + (i + 1));
const model = (await compile(lines.join("\\n") + "\\n")).model;
const asks = Array.from({ length: 8 }, (_, i) => store.get({ viewId: "v" + i, revision: "r" + i, theme: "light" },
  { schemaVersion: 2, revision: "r" + i, view: { id: "v" + i, kind: "freeform", title: "V" }, model }, { format: "png" }).then(() => "drawn", (e) => e.code));
setTimeout(() => { store.close(); painters.close(); console.log("closed"); }, 300);
console.log(JSON.stringify(await Promise.all(asks)));
`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    out += chunk;
  });
  const exited = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, 20_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
  expect(out).toContain("closed");
  expect(exited, out).toBe(0);
}, 30_000);
