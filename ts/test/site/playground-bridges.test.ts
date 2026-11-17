/// <reference lib="dom" />
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { createMarkdownRenderer } from "vitepress";
import { listExampleProjects, writePlaygroundBridges } from "../../../site/scripts/playground-bridges.mts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const documentOf = (html: string): Document => new JSDOM(html).window.document;
const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

it("lists the Playground's projects, diagrams and notes without compiling them", async () => {
  const projects = await listExampleProjects(join(repoRoot, "examples"));
  expect(
    projects.map(({ slug, pages }) => [
      slug,
      pages.filter((page) => page.path.startsWith("diagrams/")).length,
      pages.filter((page) => page.path.startsWith("notes/")).length,
    ]),
  ).toEqual([
    ["archer-tour", 8, 2],
    ["rfc-2324-htcpcp", 5, 2],
    ["rfc-1149-ipoac", 6, 3],
  ]);
  const tour = projects[0]!;
  expect(tour.title).toBe("Archer Tour");
  expect(tour.notice).toBeNull();
  expect(tour.pages.find((page) => page.path === "diagrams/heartbeat")?.title).toBe("The Heartbeat Loop");
  expect(tour.pages.find((page) => page.path === "notes/what-is-archer")?.title).toMatch(/Archer/);
  for (const project of projects)
    for (const page of project.pages)
      if (page.route.kind === "file")
        expect(existsSync(join(repoRoot, "examples", project.slug, ".archer", page.route.path)), page.path).toBe(true);
});

it.each(["/", "/archer/"])(
  "keeps old example URLs as small redirecting bridges to matching real routes at %s",
  async (base) => {
    const root = await mkdtemp(join(tmpdir(), "archer-bridges-"));
    scratch.push(root);
    const projects = await listExampleProjects(join(repoRoot, "examples"));
    await writePlaygroundBridges({ outputRoot: root, base, projects });
    const markdown = await createMarkdownRenderer(join(repoRoot, "site"));
    const app = `${base}playground/app/index.html`;
    for (const project of projects) {
      for (const page of project.pages) {
        const file = join(root, project.slug, `${page.path || "index"}.md`);
        const source = await readFile(file, "utf8");
        expect(source.length, file).toBeLessThan(1200);
        const logical =
          page.path === ""
            ? `/projects/${project.slug}/`
            : `/projects/${project.slug}/${page.path}${page.path.startsWith("diagrams/") ? ".mmd" : ".md"}`;
        const href = `${app}?route=${encodeURIComponent(logical)}`;
        // The page redirects at once, and still says where it went.
        expect(source).toContain(`"content":"0; url=${href}"`);
        expect(source).toContain("search: false");
        const document = documentOf(markdown.render(source.replace(/^---[\s\S]*?---\n/, "")));
        const open = Array.from(document.querySelectorAll("a")).find((a) => a.textContent === "Open in Playground");
        // VitePress adds the deployment base to Markdown links; the built-site browser check sees the result.
        expect(open?.getAttribute("href")).toBe(href.slice(base.length - 1));
        expect(document.querySelector("img")).toBeNull();
        if (project.notice !== null) expect(source).toContain(`/generated/examples/${project.slug}/notice`);
      }
      if (project.slug.startsWith("rfc-")) {
        // The complete notice stays published, byte for byte, as its own page.
        const notice = await readFile(join(repoRoot, "examples", project.slug, "NOTICE.md"), "utf8");
        expect(await readFile(join(root, project.slug, "notice.md"), "utf8")).toBe(
          `---\ntitle: "Distribution Notice"\n---\n\n${notice}\n`,
        );
        expect(notice).toContain("Copyright");
      } else expect(existsSync(join(root, project.slug, "notice.md"))).toBe(false);
    }
    expect(await readFile(join(root, "index.md"), "utf8")).toContain("/playground");
    // Nothing else of the gallery is written.
    const written = await readdir(root, { recursive: true, withFileTypes: true });
    expect(written.filter((entry) => entry.isFile() && !entry.name.endsWith(".md")).map((entry) => entry.name)).toEqual(
      [],
    );
  },
  30_000,
);

it("links the Playground page's notices to the bridges' notice pages", async () => {
  const playground = await readFile(join(repoRoot, "site/using-the-playground.md"), "utf8");
  const projects = await listExampleProjects(join(repoRoot, "examples"));
  const noticed = projects.filter((project) => project.notice !== null).map((project) => project.slug);
  expect(noticed.sort()).toEqual(["rfc-1149-ipoac", "rfc-2324-htcpcp"]);
  for (const slug of noticed) expect(playground).toContain(`(/generated/examples/${slug}/notice)`);
});
