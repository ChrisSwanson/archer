import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  buildPlayground,
  PLAYGROUND_CSP,
  playgroundDocument,
  writePlaygroundData,
} from "../../../site/scripts/playground-build.mts";
import { generatePlaygroundSnapshot } from "../../../site/scripts/playground-snapshot.mts";
import { assertSafeThumbnail } from "../../src/export/index.ts";
import {
  darkThumbnail,
  packSnapshot,
  unpackProject,
  type PackedProject,
  type PackedShared,
  type PlaygroundIndex,
} from "../../../shared/playground-delivery.mts";
import type { PlaygroundSnapshot } from "../../../shared/playground-snapshot.mts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratch: string[] = [];
let snapshot: PlaygroundSnapshot;
let siteRoot: string;
let output: string;
beforeAll(async () => {
  snapshot = await generatePlaygroundSnapshot({ repoRoot, examplesRoot: join(repoRoot, "examples") });
  siteRoot = await mkdtemp(join(tmpdir(), "archer-playground-build-"));
  scratch.push(siteRoot);
  // One build: the playground has a relative base, so the same files serve every docs base.
  await buildPlayground({ repoRoot, siteRoot, snapshot });
  output = join(siteRoot, "public/playground/app");
}, 120_000);
afterAll(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

const indexOf = (html: string): PlaygroundIndex =>
  JSON.parse(/<script[^>]*id="archer-playground-index"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!);

it("keeps the production web and MCP build aliases independent from the public playground", async () => {
  const { pageBuildAliases } = await import(new URL("../../../ui/vite.config.ts", import.meta.url).href);
  for (const target of ["web", "mcp"] as const)
    for (const alias of pageBuildAliases(false, target)) expect(alias.replacement).not.toContain("/playground/");
});

it("embeds literal replacement metacharacters and script terminators without changing index text", () => {
  const index = {
    formatVersion: 1,
    fontLicense: "$& $` $' </script><script>bad()</script>",
  } as unknown as PlaygroundIndex;
  const html = playgroundDocument(
    '<html><head></head><body><script id="archer-playground-index" type="application/json">__ARCHER_PLAYGROUND_INDEX__</script><script type="module" src="./assets/main.js"></script></body></html>',
    index,
  );
  expect(indexOf(html).fontLicense).toBe(index.fontLicense);
  expect(() =>
    playgroundDocument(
      '<html><head></head><body><script id="archer-playground-index" type="application/json">__ARCHER_PLAYGROUND_INDEX__</script><script>start()</script></body></html>',
      index,
    ),
  ).toThrow(/inline script/);
});

it("packs each project losslessly: shared responses once, thumbnails as light text plus dark colours", () => {
  // Thumbnails are added by the build; a synthetic pair stands in for the colour-only theme difference.
  const light = (slug: string) =>
    `<svg><title>${slug}</title><style>.a{fill:#ffffff}</style><rect fill="#0f172a"/><text fill="#ffffff">x</text></svg>`;
  const dark = (slug: string) =>
    `<svg><title>${slug}</title><style>.a{fill:#0f172a}</style><rect fill="#0f172a"/><text fill="#e2e8f0">x</text></svg>`;
  const projects = snapshot.projects.map((project) => ({
    ...project,
    responses: {
      ...project.responses,
      "api/thumbnails/x?theme=light": light(project.slug),
      "api/thumbnails/x?theme=dark": dark(project.slug),
    },
  }));
  const packed = packSnapshot({ ...snapshot, projects });
  expect(Object.keys(packed.shared.responses)).toEqual(
    expect.arrayContaining(["api/projects", "api/browser-projects"]),
  );
  for (const [position, project] of projects.entries()) {
    const own = packed.projects[position]!;
    expect(Object.keys(own.responses)).not.toContain("api/projects");
    expect(own.thumbnails["api/thumbnails/x"]).toEqual({
      svg: light(project.slug),
      dark: [
        [0, "#0f172a"],
        [2, "#e2e8f0"],
      ],
    });
    expect(darkThumbnail(own.thumbnails["api/thumbnails/x"]!)).toBe(dark(project.slug));
    expect(unpackProject(project, JSON.parse(JSON.stringify(own)), packed.shared)).toEqual(project);
  }
});

it("publishes the real static App as hashed files with per-project data, shared fonts and a self-only CSP", async () => {
  const html = await readFile(join(output, "index.html"), "utf8");
  const index = indexOf(html);
  expect(html.includes("__ARCHER_PLAYGROUND_INDEX__")).toBe(false);
  expect(html.includes("/-/page-assets/")).toBe(false);
  expect(index.projects.map((project) => project.slug)).toEqual(snapshot.projects.map((project) => project.slug));
  // No project data or App code in the document; each project is one content-named file fetched on route.
  expect(html.length).toBeLessThan(32 * 1024);
  const shared = JSON.parse(await readFile(join(output, index.shared), "utf8")) as PackedShared;
  for (const entry of index.projects) {
    expect(entry.data).toMatch(new RegExp(`^data/${entry.slug}-[a-f0-9]{16}\\.json$`));
    const packed = JSON.parse(await readFile(join(output, entry.data), "utf8")) as PackedProject;
    const project = unpackProject(entry, packed, shared);
    const views = (project.responses["api/diagrams"] as { views: { id: string }[] }).views;
    for (const view of views)
      for (const theme of ["light", "dark"]) {
        const svg = project.responses[`api/thumbnails/${encodeURIComponent(view.id)}?theme=${theme}`];
        expect(typeof svg, `${entry.slug} ${view.id} ${theme}`).toBe("string");
        expect(() => assertSafeThumbnail(svg as string)).not.toThrow();
      }
    expect(Object.keys(packed.thumbnails)).toHaveLength(views.length);
  }
  const assets = await readdir(join(output, "assets"));
  expect(assets.filter((file) => /^playground-[\w-]+\.js$/.test(file))).toHaveLength(1);
  expect(assets.some((file) => file.endsWith(".woff2"))).toBe(false);
  expect(await readdir(join(siteRoot, "public/fonts"))).toEqual(
    expect.arrayContaining(["fira-sans-latin-400.woff2", "fira-sans-latin-700.woff2"]),
  );
  const css = (
    await Promise.all(
      assets.filter((file) => file.endsWith(".css")).map((file) => readFile(join(output, "assets", file), "utf8")),
    )
  ).join("");
  expect(css).toMatch(/url\("?\.\.\/\.\.\/\.\.\/fonts\/fira-sans-latin-400\.woff2"?\)/);
  expect(css).not.toContain("data:font");
  // Build evidence stays out of the published tree.
  await expect(readdir(join(output, ".vite"))).rejects.toThrow();
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"\s*\/?\s*>/.exec(html);
  expect(meta?.[1]).toBe(PLAYGROUND_CSP);
  expect(PLAYGROUND_CSP).toContain("script-src 'self'");
  expect(PLAYGROUND_CSP).toContain("connect-src 'self'");
  expect(PLAYGROUND_CSP).not.toContain("sha256-");
  expect(PLAYGROUND_CSP).not.toContain("frame-ancestors");
  expect(html.indexOf(meta![0])).toBeLessThan(html.indexOf("<script"));
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))
    if (!/type="application\/json"/.test(match[1]!)) expect(match[2]!.trim()).toBe("");
});

it("preloads the shell's chunks, and lists what a docs page warms, from the manifest", async () => {
  const html = await readFile(join(output, "index.html"), "utf8");
  const index = indexOf(html);
  const [worker] = await readdir(join(output, "page-assets"));
  const assets = await readdir(join(output, "assets"));
  const named = (stem: string, ext: string) =>
    assets.filter((file) => file.startsWith(`${stem}-`) && file.endsWith(ext));
  // Chromium rejects a worker preload (the entry starts the worker early instead, ui/src/playground/worker.ts).
  expect(html).not.toContain('as="worker"');
  // The shell view's own chunks (lazy in the bundle) are fetched in parallel with the entry.
  for (const file of [...named("mount-shell", ".js"), ...named("OldVersionStage", ".js"), ...named("WalkList", ".js")])
    expect(html, file).toContain(`<link rel="modulepreload" crossorigin href="./assets/${file}">`);
  for (const file of [...named("mount-shell", ".css"), ...named("WalkList", ".css")])
    expect(html, file).toContain(`<link rel="preload" href="./assets/${file}" as="style" crossorigin>`);
  // Whatever a first view needs, relative to the document; the docs pages prefetch it once the page is idle.
  const warm = JSON.parse(await readFile(join(output, "warm.json"), "utf8")) as { files: string[] };
  expect(warm.files[0]).toBe("index.html");
  expect(warm.files).toEqual(
    expect.arrayContaining([
      ...named("playground", ".js").map((file) => `assets/${file}`),
      ...named("playground", ".css").map((file) => `assets/${file}`),
      ...named("mount-shell", ".js").map((file) => `assets/${file}`),
      ...named("mount-scene", ".js").map((file) => `assets/${file}`),
      `page-assets/${worker}`,
      index.shared,
      index.projects.find((project) => project.slug === "archer-tour")!.data,
    ]),
  );
  expect(new Set(warm.files).size).toBe(warm.files.length);
  for (const file of warm.files) await expect(readFile(join(output, file))).resolves.toBeDefined();
  // Only the routed projects' data: the other examples load when opened.
  expect(warm.files.filter((file) => file.startsWith("data/"))).toHaveLength(2);
});

it("names the layout worker relative to its chunk, so it resolves beside the document at every base", async () => {
  const workers = await readdir(join(output, "page-assets"));
  expect(workers).toHaveLength(1);
  const chunks = (await readdir(join(output, "assets"))).filter((file) => file.endsWith(".js"));
  const referencing: { chunk: string; reference: string }[] = [];
  for (const chunk of chunks) {
    const text = await readFile(join(output, "assets", chunk), "utf8");
    for (const match of text.matchAll(/["'`]((?:\.{1,2}\/)*page-assets\/[\w.-]+\.js)["'`]/g))
      referencing.push({ chunk, reference: match[1]! });
  }
  expect(referencing.length).toBeGreaterThan(0);
  for (const base of ["/", "/archer/"])
    for (const { chunk, reference } of referencing)
      expect(new URL(reference, `https://examples.invalid${base}playground/app/assets/${chunk}`).pathname).toBe(
        `${base}playground/app/page-assets/${workers[0]}`,
      );
});

it("refuses to publish data that does not restore its exact responses", async () => {
  const broken = {
    ...snapshot,
    projects: snapshot.projects.map((project, position) =>
      position === 0
        ? { ...project, responses: { ...project.responses, "api/bad": { "\u0000archer-string": 0 } } }
        : project,
    ),
  };
  const target = await mkdtemp(join(tmpdir(), "archer-playground-data-"));
  scratch.push(target);
  await expect(writePlaygroundData(target, broken)).rejects.toThrow(/reserved string-reference key/);
});
