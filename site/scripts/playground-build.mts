import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { build } from "vite";
import type { PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
import { HERO_PROJECT, packSnapshot, unpackProject, type PlaygroundIndex } from "../../shared/playground-delivery.mts";
import { generatePlaygroundSnapshot, serializePlaygroundSnapshot } from "./playground-snapshot.mts";
import { assertSizeBudget, entryFiles, takeManifest, type BuildManifest, type SizeBudget } from "./size-budget.mts";
import { installationAsset } from "../../ts/src/assets.ts";
import { exportThumbnail } from "../../ts/src/export/index.ts";

export interface PlaygroundBuildOptions {
  readonly repoRoot: string;
  readonly siteRoot: string;
  readonly snapshot?: PlaygroundSnapshot;
}

/** The docs site's shared font directory, relative to the site root; the playground's CSS names it relatively. */
export const SHARED_FONTS_DIR = "fonts";
/** From `<base>/playground/app/assets/*.css` to `<base>/fonts/`. */
const FONTS_FROM_PLAYGROUND_CSS = `../../../${SHARED_FONTS_DIR}/`;
const INDEX_MARKER = "__ARCHER_PLAYGROUND_INDEX__";
/** The docs pages' warm-up list, beside the document (`warmList`). */
export const WARM_LIST = "warm.json";

/**
 * The public document's meta CSP. Every script is a same-origin file, so no inline hashes; data is fetched
 * only from the document's own files. The service's framing/auth policy stays separate.
 */
export const PLAYGROUND_CSP = [
  "default-src 'none'",
  "connect-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Every face the page's stylesheet names, fetched with the document rather than on first use: the docs site
 * shares these files (usually cached already), and a face first used by an interaction would otherwise be a
 * request after the page has drawn.
 */
export function fontPreloads(names: readonly string[]): string {
  return names
    .map(
      (name) => `<link rel="preload" href="../../${SHARED_FONTS_DIR}/${name}" as="font" type="font/woff2" crossorigin>`,
    )
    .join("");
}

/** The views' entries in the build manifest: the shell (with the walkthrough stage it loads before drawing) and the scene. */
const SHELL_CHUNKS = ["src/playground/mount-shell.tsx", "src/walkthroughs/OldVersionStage.tsx"] as const;
const SCENE_CHUNKS = ["src/playground/mount-scene.tsx"] as const;
const ENTRY = "playground.html";

/**
 * What the document fetches beside its entry so nothing waits on the App booting: the shell's chunks. (The layout
 * worker cannot be preloaded: Chromium rejects `as="worker"`. The entry starts it instead, `ui/src/playground/worker.ts`.)
 */
export interface DocumentPreloads {
  readonly modules: readonly string[];
  readonly styles: readonly string[];
}

/** The shell view's files that the entry does not already load (Vite preloads those), from the manifest. */
export function documentPreloads(manifest: BuildManifest): DocumentPreloads {
  const boot = new Set(entryFiles(manifest, ENTRY));
  const shell = entryFiles(manifest, ...SHELL_CHUNKS).filter((file) => !boot.has(file));
  return {
    modules: shell.filter((file) => file.endsWith(".js")),
    styles: shell.filter((file) => file.endsWith(".css")),
  };
}

export function preloadTags(preloads: DocumentPreloads): string {
  return [
    ...preloads.modules.map((file) => `<link rel="modulepreload" crossorigin href="./${file}">`),
    ...preloads.styles.map((file) => `<link rel="preload" href="./${file}" as="style" crossorigin>`),
  ].join("");
}

/**
 * Everything a first view fetches, relative to the document, for the docs pages to prefetch once idle
 * (`site/.vitepress/theme/warm-playground.mts`): the document, its entry, both views' chunks, the layout worker,
 * the shared responses and the data of the Tour (the default and the landing's project). Derived from the manifest.
 */
export function warmList(manifest: BuildManifest, worker: string, index: PlaygroundIndex): string[] {
  const tour = index.projects.find((project) => project.slug === HERO_PROJECT) ?? index.projects[0]!;
  const first = index.projects[0]!;
  return [
    ...new Set([
      "index.html",
      ...entryFiles(manifest, ENTRY, ...SHELL_CHUNKS, ...SCENE_CHUNKS),
      worker,
      index.shared,
      tour.data,
      first.data,
    ]),
  ];
}

export function playgroundDocument(
  html: string,
  index: PlaygroundIndex,
  fonts: readonly string[] = [],
  preloads?: DocumentPreloads,
): string {
  if (html.split(INDEX_MARKER).length !== 2) throw new Error("Playground HTML must contain exactly one index marker");
  const body = html.replace(INDEX_MARKER, () => serializePlaygroundSnapshot(index));
  for (const match of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))
    if (!/\btype=["']application\/json["']/.test(match[1]!) && match[2]!.trim() !== "")
      throw new Error("The playground document must not carry inline script; its CSP admits only its own files.");
  return body.replace(
    /<head>/i,
    `<head><meta http-equiv="Content-Security-Policy" content="${PLAYGROUND_CSP}">${fontPreloads(fonts)}${preloads ? preloadTags(preloads) : ""}`,
  );
}

async function withThumbnails(snapshot: PlaygroundSnapshot): Promise<PlaygroundSnapshot> {
  const projects = [];
  const themeCss = installationAsset("export/theme.css").toString("utf8");
  for (const project of snapshot.projects) {
    const responses = { ...project.responses };
    const inventory = responses["api/diagrams"] as { readonly views: readonly { readonly id: string }[] };
    for (const view of inventory.views) {
      for (const theme of ["light", "dark"] as const) {
        const thumbnail = await exportThumbnail(responses[`api/diagrams/${encodeURIComponent(view.id)}`], {
          theme,
          themeCss,
        });
        responses[`api/thumbnails/${encodeURIComponent(view.id)}?${new URLSearchParams({ theme })}`] =
          new TextDecoder().decode(thumbnail.bytes);
      }
    }
    projects.push({ ...project, responses });
  }
  const { digest: _digest, ...manifest } = snapshot.manifest;
  const digest = `sha256:${createHash("sha256")
    .update(JSON.stringify({ ...manifest, projects, fontLicense: snapshot.fontLicense }))
    .digest("hex")}`;
  return { ...snapshot, manifest: { ...manifest, digest }, projects };
}

const contentName = (stem: string, text: string): string =>
  `data/${stem}-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.json`;

/** Pack, prove the round trip, and write one content-named file per project plus the shared responses. */
export async function writePlaygroundData(output: string, snapshot: PlaygroundSnapshot): Promise<PlaygroundIndex> {
  const packed = packSnapshot(snapshot);
  const sharedText = JSON.stringify(packed.shared);
  const files = new Map<string, string>([[contentName("shared", sharedText), sharedText]]);
  const projects = snapshot.projects.map((project, position) => {
    const text = JSON.stringify(packed.projects[position]);
    const restored = unpackProject(project, JSON.parse(text), JSON.parse(sharedText));
    if (!isDeepStrictEqual(restored, project))
      throw new Error(`The packed example ${project.slug} does not restore its exact responses.`);
    const data = contentName(project.slug, text);
    files.set(data, text);
    return { slug: project.slug, name: project.name, ...(project.notice ? { notice: project.notice } : {}), data };
  });
  await mkdir(join(output, "data"), { recursive: true });
  for (const [name, text] of files) await writeFile(join(output, name), text);
  return {
    formatVersion: 1,
    manifest: snapshot.manifest,
    fontLicense: snapshot.fontLicense,
    shared: [...files.keys()][0]!,
    projects,
  };
}

/** The page's font files, once, where the docs stylesheet and the playground both name them. */
export async function writeSharedFonts(repoRoot: string, siteRoot: string): Promise<string[]> {
  const from = join(repoRoot, "ui/src/theme/fonts");
  const to = join(siteRoot, "public", SHARED_FONTS_DIR);
  await mkdir(to, { recursive: true });
  const names = (await readdir(from)).filter((name) => name.endsWith(".woff2")).sort();
  for (const name of names) await copyFile(join(from, name), join(to, name));
  return names;
}

/**
 * Gzip-9 limits from the build manifest. `boot` is the document and its entry; `playground` and `hero` are
 * everything a first visit fetches for that view: entry, view chunks, its project's data and the layout worker.
 * 2026-11-13: boot 124 KB, playground 1.06 MB, hero 878 KB, largest chunk 191 KB, worker 472 KB, data 35 KB.
 */
export function playgroundBudget(index: PlaygroundIndex, worker: string): SizeBudget {
  const data = (slug: string) => [index.shared, index.projects.find((project) => project.slug === slug)!.data];
  const first = index.projects[0]!.slug;
  return {
    entries: {
      boot: { chunks: ["playground.html"], files: ["index.html"], limit: 136 * 1024 },
      playground: {
        // The shell view also loads the App's deferred walkthrough stage before it draws.
        chunks: ["playground.html", "src/playground/mount-shell.tsx", "src/walkthroughs/OldVersionStage.tsx"],
        files: ["index.html", worker, ...data(first)],
        limit: 1200 * 1024,
      },
      hero: {
        chunks: ["playground.html", "src/playground/mount-scene.tsx"],
        files: ["index.html", worker, ...data(HERO_PROJECT)],
        limit: 960 * 1024,
      },
    },
    chunk: 224 * 1024,
    files: { "data/": 64 * 1024, "page-assets/": 512 * 1024 },
  };
}

export async function buildPlayground(options: PlaygroundBuildOptions): Promise<void> {
  // The UI config uses its own Bundler TypeScript settings, rather than the
  // backend's NodeNext/noUncheckedIndexedAccess settings.
  const { playgroundBuildConfig } = await import(new URL("../../ui/vite.playground.config.ts", import.meta.url).href);
  const output = join(options.siteRoot, "public/playground/app");
  const snapshot = await withThumbnails(
    options.snapshot ??
      (await generatePlaygroundSnapshot({
        repoRoot: options.repoRoot,
        examplesRoot: join(options.repoRoot, "examples"),
      })),
  );
  await build(playgroundBuildConfig(output, { fontsUrl: FONTS_FROM_PLAYGROUND_CSS }));
  const manifest = await takeManifest(output);
  const fonts = await writeSharedFonts(options.repoRoot, options.siteRoot);
  const index = await writePlaygroundData(output, snapshot);
  const workers = (await readdir(join(output, "page-assets"))).map((name) => `page-assets/${name}`);
  if (workers.length !== 1)
    throw new Error(`The playground must publish exactly one layout worker, not ${workers.length}.`);
  const html = await readFile(join(output, "playground.html"), "utf8");
  await writeFile(join(output, "index.html"), playgroundDocument(html, index, fonts, documentPreloads(manifest)));
  await rm(join(output, "playground.html"));
  await writeFile(join(output, WARM_LIST), `${JSON.stringify({ files: warmList(manifest, workers[0]!, index) })}\n`);
  await assertSizeBudget("Playground", output, manifest, playgroundBudget(index, workers[0]!), [
    index.shared,
    ...index.projects.map((project) => project.data),
    ...workers,
  ]);
}
