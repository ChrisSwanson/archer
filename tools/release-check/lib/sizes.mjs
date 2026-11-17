// Report-only size measurements for `npm run release-check` (performance passes: new measurements beside the caps,
// none of them gates yet): every file the web build emits and their total, bytes per source bucket through the
// build's sourcemaps with the change against a base build, and one line per lab route and scale page.
// Pure except listAssets/attributeBuild, which read a build directory.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fmtBytes } from "./gate.mjs";

/** raw, gzip (level 9, like the page cap) and brotli (default quality) bytes. */
export const sizeOf = (bytes) => ({
  raw: bytes.length,
  gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes).length,
});

/**
 * Every file a build emitted (sourcemaps left out), with its sizes: what the service would serve, so a worker or
 * chunk split out of index.html is measured too. `known` reuses sizes already computed ({path: size}).
 */
export function listAssets(dir, known = {}) {
  return emitted(dir).map((path) => ({ path, ...(known[path] ?? sizeOf(readFileSync(join(dir, path)))) }));
}

/** Every file under `dir` but sourcemaps, `/`-separated, index.html first. */
const emitted = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      relative(dir, join(e.parentPath ?? e.path, e.name))
        .split("\\")
        .join("/"),
    )
    .filter((f) => !f.endsWith(".map"))
    .sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));

/**
 * What ships with a page: `entry` and every emitted file it names, transitively (a worker's own chunks too), by
 * its path relative to the naming file. Sourcemaps are left out, and so is a file nothing names (another page's
 * folder, a stale asset). Returns paths relative to `dir`, the entry first.
 */
export function referencedAssets(dir, entry = "index.html") {
  const files = emitted(dir),
    out = [entry];
  for (let i = 0; i < out.length; i++) {
    const body = readFileSync(join(dir, out[i]), "latin1");
    for (const f of files) if (!out.includes(f) && body.includes(posix.relative(posix.dirname(out[i]), f))) out.push(f);
  }
  return out;
}

/** The distribution's total over listAssets rows. */
export const distribution = (assets) =>
  assets.reduce(
    (t, a) => ({ files: t.files + 1, raw: t.raw + a.raw, gzip: t.gzip + a.gzip, brotli: t.brotli + a.brotli }),
    { files: 0, raw: 0, gzip: 0, brotli: 0 },
  );

const sized = (s) => `${fmtBytes(s.raw)} (gzip ${fmtBytes(s.gzip)}, br ${fmtBytes(s.brotli)})`;

/** Report lines for the page-build step. */
export function assetLines(assets, max = 12) {
  const total = distribution(assets);
  return [
    ...assets.slice(0, max).map((a) => `report asset ${a.path}: ${sized(a)}`),
    ...(assets.length > max ? [`report asset … ${assets.length - max} more`] : []),
    `report every emitted file: ${total.files} file${total.files === 1 ? "" : "s"}, ${sized(total)}`,
  ];
}

/**
 * A source path from a sourcemap → its bucket: an npm package (a scope or the d3-* family as one), else the
 * first folder under ui/src, shared or ts/src. Generic on purpose: no list of features to keep up to date.
 */
export function bucketOf(source) {
  const s = String(source ?? "")
    .split("\\")
    .join("/");
  const nm = s.lastIndexOf("node_modules/");
  if (nm >= 0) {
    const name = s.slice(nm + "node_modules/".length).split("/")[0];
    return `npm ${name.startsWith("@") ? `${name}/*` : name.replace(/^d3-.*/, "d3-*")}`;
  }
  const own = s.match(/(?:^|\/)(ui\/src|shared|ts\/src)\/(.+)$/);
  if (own) {
    const parts = own[2].split("/");
    return `${own[1]}/${parts.length > 1 ? parts[0] : "(files)"}`;
  }
  return s.startsWith("\0") || /(^|\/)vite\//.test(s) || s === "" ? "bundler" : "other";
}

/** Walks a sourcemap in generated order: each generated span goes to the bucket of its source. */
export function attribute(code, map, SourceMapConsumer, into = new Map()) {
  const lines = code.split("\n");
  const add = (bucket, text) => {
    if (text) (into.get(bucket) ?? into.set(bucket, []).get(bucket)).push(text);
  };
  const consumer = new SourceMapConsumer(map);
  let line = 1,
    col = 0,
    bucket = "unmapped";
  const flushTo = (toLine, toCol) => {
    while (line < toLine) {
      add(bucket, lines[line - 1]?.slice(col) ?? "");
      line++;
      col = 0;
      bucket = "unmapped";
    }
    add(bucket, lines[line - 1]?.slice(col, toCol) ?? "");
    col = toCol;
  };
  consumer.eachMapping(
    (m) => {
      flushTo(m.generatedLine, m.generatedColumn);
      bucket = m.source ? bucketOf(m.source) : "unmapped";
    },
    null,
    SourceMapConsumer.GENERATED_ORDER,
  );
  flushTo(lines.length, Infinity);
  return into;
}

/**
 * Bytes per bucket of a build directory: every script (inline in an HTML file, or a .js file) that names a
 * sourcemap present in the directory is split by its map; CSS (inline <style> or .css) is one bucket, data: URIs
 * inside it another; the rest of each HTML file is "html". Returns {bucket: {raw, gzip}} (gzip of each bucket
 * on its own, so buckets add up to a little more than the whole).
 */
export function attributeBuild(dir, SourceMapConsumer) {
  const chunks = new Map();
  const add = (bucket, text) => {
    if (text) (chunks.get(bucket) ?? chunks.set(bucket, []).get(bucket)).push(text);
  };
  // A map URL is relative to the script that names it (a worker under page-assets/ names its neighbour).
  const mapFor = (code, path) => {
    const name = code.match(/\/\/# sourceMappingURL=([^\s]+)\s*$/)?.[1];
    if (!name || name.startsWith("data:")) return null;
    try {
      return JSON.parse(readFileSync(join(dir, dirname(path), name), "utf8"));
    } catch {
      return null;
    }
  };
  const script = (code, path) => {
    const map = mapFor(code, path);
    if (map) attribute(code, map, SourceMapConsumer, chunks);
    else add(`unmapped ${path}`, code);
  };
  const css = (text) => {
    const data = text.match(/url\(\s*["']?data:[^)]*\)/g) ?? [];
    add("css data: URIs", data.join(""));
    add(
      "css",
      data.reduce((t, d) => t.replace(d, ""), text),
    );
  };
  for (const path of listAssets(dir, {}).map((a) => a.path)) {
    const text = readFileSync(join(dir, path), "utf8");
    if (/\.html$/.test(path)) {
      let rest = text;
      rest = rest.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, (_, code) => {
        script(code, path);
        return "";
      });
      rest = rest.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/g, (_, style) => {
        css(style);
        return "";
      });
      add("html", rest);
    } else if (/\.m?js$/.test(path)) script(text, path);
    else if (/\.css$/.test(path)) css(text);
    else add(`file ${path}`, text);
  }
  return Object.fromEntries(
    [...chunks].map(([bucket, parts]) => {
      const buf = Buffer.from(parts.join(""));
      return [bucket, { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length }];
    }),
  );
}

const signed = (b) => `${b > 0 ? "+" : b < 0 ? "-" : "±"}${fmtBytes(Math.abs(b))}`;

/** Report lines: the largest changes per bucket (gzip), then the biggest buckets now. `base` may be null. */
export function bucketLines(head, base, { label = "base", top = 10 } = {}) {
  const names = [...new Set([...Object.keys(head), ...Object.keys(base ?? {})])];
  const gz = (o, k) => o?.[k]?.gzip ?? 0;
  const total = (o) => Object.values(o ?? {}).reduce((t, v) => t + v.gzip, 0);
  const lines = [];
  if (base) {
    const moved = names
      .map((k) => [k, gz(head, k) - gz(base, k)])
      .filter(([, d]) => d !== 0)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    lines.push(
      `report buckets vs ${label} (gzip each): ${signed(total(head) - total(base))} in all; ${
        moved.length
          ? moved
              .slice(0, top)
              .map(([k, d]) => `${k} ${signed(d)} (${fmtBytes(gz(head, k))})`)
              .join(", ")
          : "no bucket changed"
      }`,
    );
  }
  const biggest = Object.entries(head)
    .sort((a, b) => b[1].gzip - a[1].gzip)
    .slice(0, top);
  lines.push(`report buckets now (gzip each): ${biggest.map(([k, v]) => `${k} ${fmtBytes(v.gzip)}`).join(", ")}`);
  return lines;
}

/** One lab route: first-load bytes, the DOM's shape, and the heap after GC (main thread, workers). */
export function routeLine(page) {
  const f = page.firstLoad,
    d = page.dom,
    h = page.heapAfterGc;
  const load = f
    ? `first load ${fmtBytes(f.total)} over ${f.files} file${f.files === 1 ? "" : "s"} (document ${fmtBytes(f.page)}, scripts ${fmtBytes(f.scripts)}, workers ${fmtBytes(f.workers)}, styles ${fmtBytes(f.styles)}, fonts ${fmtBytes(f.fonts)})`
    : "first load not measured";
  const heap =
    typeof h?.mainMb === "number"
      ? `; heap after GC ${h.mainMb} MB${h.workerMb === 0 ? ", no worker" : typeof h.workerMb === "number" ? `, workers ${h.workerMb} MB` : ""}`
      : "";
  return `${load}; DOM ${d ? domLine(d) : "not measured"}${heap}`;
}

/** total = shell + rows × elements per row + headers + the rest of <main>. */
export function domLine(d) {
  return `${d.total} = shell ${d.shell ?? "?"} + ${d.rows} rows × ${d.perRow ?? 0} (max ${d.maxPerRow ?? 0}) + ${d.headers} header${d.headers === 1 ? "" : "s"} (${d.headerElements}) + rest of main ${d.otherInMain ?? "?"}`;
}
