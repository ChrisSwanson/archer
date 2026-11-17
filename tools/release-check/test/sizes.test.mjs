// node --test tools/release-check/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetLines,
  attribute,
  attributeBuild,
  bucketLines,
  bucketOf,
  distribution,
  domLine,
  listAssets,
  referencedAssets,
  routeLine,
} from "../lib/sizes.mjs";

const { SourceMapConsumer, SourceMapGenerator } = createRequire(import.meta.url)("source-map-js");

test("bucketOf: npm packages (scopes and d3-* as one), the first folder of our own sources", () => {
  assert.equal(bucketOf("../../node_modules/react-dom/cjs/react-dom-client.production.js"), "npm react-dom");
  assert.equal(bucketOf("/x/node_modules/@codemirror/view/dist/index.js"), "npm @codemirror/*");
  assert.equal(bucketOf("/x/node_modules/d3-zoom/src/zoom.js"), "npm d3-*");
  assert.equal(bucketOf("../../../home/u/archer/ui/src/app/App.tsx"), "ui/src/app");
  assert.equal(bucketOf("/tmp/base/ui/src/main.tsx"), "ui/src/(files)");
  assert.equal(bucketOf("../shared/note-markdown.mjs"), "shared/(files)");
  assert.equal(bucketOf("\0vite/preload-helper.js"), "bundler");
});

test("attribute: each generated span goes to its source's bucket, text before a line's first mapping is unmapped", () => {
  const code = "AAAABBB\nxxCC";
  const gen = new SourceMapGenerator({ file: "out.js" });
  const at = (line, column, source) =>
    gen.addMapping({ generated: { line, column }, original: { line: 1, column: 0 }, source });
  at(1, 0, "/r/ui/src/app/a.ts");
  at(1, 4, "/r/node_modules/react/index.js");
  at(2, 2, "/r/ui/src/app/b.ts");
  const out = attribute(code, JSON.parse(gen.toString()), SourceMapConsumer);
  assert.deepEqual(Object.fromEntries([...out].map(([k, v]) => [k, v.join("")])), {
    "ui/src/app": "AAAACC",
    "npm react": "BBB",
    unmapped: "xx",
  });
});

test("listAssets and attributeBuild: every emitted file but maps; inline scripts split by their map, CSS and data: URIs apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "archer-sizes-test-"));
  try {
    const gen = new SourceMapGenerator({ file: "index.js" });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "/r/ui/src/app/App.tsx",
    });
    writeFileSync(join(dir, "index.js.map"), gen.toString());
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><style>a{b:c}i{background:url(data:image/png;base64,AAAA)}</style><script type="module">run();\n//# sourceMappingURL=index.js.map</script>`,
    );
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "worker-abc.js"), "self.onmessage=()=>{};");
    const assets = listAssets(dir);
    assert.deepEqual(
      assets.map((a) => a.path),
      ["index.html", "assets/worker-abc.js"],
    );
    assert.equal(distribution(assets).raw, assets[0].raw + assets[1].raw);
    assert.match(assetLines(assets).at(-1), /^report every emitted file: 2 files, /);
    const b = attributeBuild(dir, SourceMapConsumer);
    assert.deepEqual(Object.keys(b).sort(), [
      "css",
      "css data: URIs",
      "html",
      "ui/src/app",
      "unmapped",
      "unmapped assets/worker-abc.js",
    ]);
    assert.equal(
      b.unmapped.raw,
      "//# sourceMappingURL=index.js.map".length,
      "the map comment is the only unmapped line",
    );
    assert.equal(b["css data: URIs"].raw, "url(data:image/png;base64,AAAA)".length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bucketLines: the largest gzip changes against the base, then the biggest buckets now", () => {
  const head = { a: { raw: 10, gzip: 5000 }, b: { raw: 10, gzip: 2048 }, c: { raw: 1, gzip: 100 } };
  const base = { a: { raw: 10, gzip: 5000 }, b: { raw: 10, gzip: 1024 }, d: { raw: 1, gzip: 50 } };
  const [delta, now] = bucketLines(head, base, { label: "main", top: 2 });
  assert.equal(delta, "report buckets vs main (gzip each): +1 KB in all; b +1 KB (2 KB), c +100 B (100 B)");
  assert.equal(now, "report buckets now (gzip each): a 5 KB, b 2 KB");
  assert.equal(bucketLines(head, null).length, 1);
});

test("routeLine and domLine: first-load bytes by kind and the DOM as shell + rows × per row + the rest", () => {
  const dom = {
    total: 1000,
    shell: 200,
    rows: 4,
    rowElements: 93,
    perRow: 23.3,
    maxPerRow: 30,
    headers: 1,
    headerElements: 12,
    otherInMain: 695,
  };
  assert.equal(domLine(dom), "1000 = shell 200 + 4 rows × 23.3 (max 30) + 1 header (12) + rest of main 695");
  assert.equal(
    routeLine({
      firstLoad: { page: 1024, scripts: 0, workers: 2048, styles: 0, fonts: 0, total: 3072, decoded: 0, files: 2 },
      dom,
    }),
    "first load 3 KB over 2 files (document 1 KB, scripts 0 B, workers 2 KB, styles 0 B, fonts 0 B); DOM 1000 = shell 200 + 4 rows × 23.3 (max 30) + 1 header (12) + rest of main 695",
  );
  assert.equal(routeLine({}), "first load not measured; DOM not measured");
});

test("attributeBuild resolves each script's sourcemap beside that script, so a worker's map under page-assets/ is found (Codex 7)", () => {
  const dir = mkdtempSync(join(tmpdir(), "archer-sizes-test-"));
  try {
    mkdirSync(join(dir, "page-assets"));
    const gen = new SourceMapGenerator({ file: "w.js" });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 1, column: 0 },
      source: "/r/node_modules/elkjs/lib/elk.js",
    });
    writeFileSync(join(dir, "page-assets", "w-abc.js.map"), gen.toString());
    writeFileSync(join(dir, "page-assets", "w-abc.js"), "self.onmessage=()=>{};\n//# sourceMappingURL=w-abc.js.map");
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    const b = attributeBuild(dir, SourceMapConsumer);
    assert.ok(b["npm elkjs"], `the worker is split by its map: ${Object.keys(b).join(", ")}`);
    assert.equal(b["unmapped page-assets/w-abc.js"], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("referencedAssets: index.html and every file it names, transitively; a file nothing names is not shipped with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "archer-sizes-test-"));
  try {
    mkdirSync(join(dir, "page-assets"));
    mkdirSync(join(dir, "mcp"));
    writeFileSync(
      join(dir, "index.html"),
      `<script>new Worker(new URL("page-assets/w-abc.js", import.meta.url))</script>`,
    );
    writeFileSync(join(dir, "page-assets", "w-abc.js"), `importScripts("./w-chunk-1.js")`);
    writeFileSync(join(dir, "page-assets", "w-chunk-1.js"), "x");
    writeFileSync(join(dir, "page-assets", "stale-old.js"), "y");
    writeFileSync(join(dir, "mcp", "index.html"), "z");
    assert.deepEqual(referencedAssets(dir), ["index.html", "page-assets/w-abc.js", "page-assets/w-chunk-1.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routeLine names the heap after GC, main thread and workers apart", () => {
  assert.equal(
    routeLine({ heapAfterGc: { mainMb: 4.83, workerMb: 7.1 } }),
    "first load not measured; DOM not measured; heap after GC 4.83 MB, workers 7.1 MB",
  );
  assert.equal(
    routeLine({ heapAfterGc: { mainMb: 4.83, workerMb: 0 } }),
    "first load not measured; DOM not measured; heap after GC 4.83 MB, no worker",
  );
  assert.equal(
    routeLine({ heapAfterGc: { mainMb: 4.83, workerMb: null } }),
    "first load not measured; DOM not measured; heap after GC 4.83 MB",
  );
});
