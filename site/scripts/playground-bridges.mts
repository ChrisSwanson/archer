import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import MarkdownIt from "markdown-it";
import { browserRoutePath, type BrowserRoute } from "../../shared/browser-routes.mts";
import { encodeAddressFor } from "../../ui/src/playground/address.ts";
import { findProject, listDiagrams, listNotes, readInFolder, splitFrontMatter } from "../../ts/src/project/index.ts";
import { PLAYGROUND_PROJECTS } from "./playground-snapshot.mts";

/** One retired Examples page: its old address under the project, and the Playground route that replaced it. */
export interface ExamplePage {
  /** Old page path relative to `/generated/examples/<slug>/`, without `.md`; `""` is the project landing. */
  readonly path: string;
  readonly title: string;
  readonly route: BrowserRoute;
}
export interface ExampleProject {
  readonly slug: string;
  readonly title: string;
  /** The project's complete NOTICE.md, published as its own page for the RFC text in the Playground. */
  readonly notice: string | null;
  readonly pages: readonly ExamplePage[];
}

const markdown = new MarkdownIt({ html: false });
function noteTitle(body: string, path: string): string {
  const tokens = markdown.parse(body, {});
  const at = tokens.findIndex((token) => token.type === "heading_open");
  return (at >= 0 ? tokens[at + 1]?.content : undefined) ?? basename(path, ".md");
}

/** The Playground's projects, read (never compiled) for the addresses the retired gallery published. */
export async function listExampleProjects(examplesRoot: string): Promise<ExampleProject[]> {
  const projects: ExampleProject[] = [];
  for (const slug of PLAYGROUND_PROJECTS) {
    const project = findProject(join(examplesRoot, slug));
    if (project.problems.length)
      throw new Error(`Invalid example ${slug}: ${project.problems.map((p) => p.message).join("; ")}`);
    const title = project.name ?? slug;
    const pages: ExamplePage[] = [{ path: "", title, route: { kind: "browse", projectSlug: slug, folder: "" } }];
    for (const entry of listDiagrams(project)) {
      const id = entry.view?.id ?? basename(entry.path, ".mmd");
      pages.push({
        path: `diagrams/${id}`,
        title: entry.view?.title ?? id,
        route: { kind: "file", projectSlug: slug, path: entry.path },
      });
    }
    for (const note of listNotes(project)) {
      const { body } = splitFrontMatter(readInFolder(project, note.path).toString("utf8"));
      pages.push({
        path: note.path.replace(/\.md$/, ""),
        title: noteTitle(body, note.path),
        route: { kind: "file", projectSlug: slug, path: note.path },
      });
    }
    const noticePath = join(project.root, "NOTICE.md");
    projects.push({ slug, title, notice: existsSync(noticePath) ? await readFile(noticePath, "utf8") : null, pages });
  }
  return projects;
}

/** The Playground document link for a route, through the same address encoder the Playground page uses. */
export function playgroundHref(route: BrowserRoute, base: string): string {
  const logical = browserRoutePath(route);
  if (logical === null) throw new Error(`No Playground address for ${JSON.stringify(route)}`);
  const url = new URL(encodeAddressFor(new URL(`https://docs.invalid${base}playground/app/index.html`), logical));
  return `${url.pathname}${url.search}${url.hash}`;
}

/** A retired Examples address: it redirects at once and keeps a visible link for readers that do not refresh. */
export function bridgePage(page: ExamplePage, base: string, noticeLink: string | null): string {
  const refresh = JSON.stringify([
    "meta",
    { "http-equiv": "refresh", content: `0; url=${playgroundHref(page.route, base)}` },
  ]);
  // VitePress adds the base to Markdown links itself.
  const link = playgroundHref(page.route, "/");
  const notice = noticeLink === null ? "" : `\n[Distribution notice](${noticeLink})\n`;
  return `---\ntitle: ${JSON.stringify(page.title)}\noutline: false\nsearch: false\nhead: [${refresh}]\n---\n\n# ${page.title}\n\nThis example is now interactive in the Playground.\n\n[Open in Playground](${link})\n${notice}`;
}

/** Retain published addresses while moving the browsing experience into the real Playground. */
export async function writePlaygroundBridges(options: {
  outputRoot: string;
  base: string;
  projects: readonly ExampleProject[];
}): Promise<void> {
  for (const project of options.projects) {
    const folder = join(options.outputRoot, project.slug);
    await mkdir(folder, { recursive: true });
    let noticeLink: string | null = null;
    if (project.notice !== null) {
      await writeFile(join(folder, "notice.md"), `---\ntitle: "Distribution Notice"\n---\n\n${project.notice}\n`);
      noticeLink = `/generated/examples/${project.slug}/notice`;
    }
    for (const page of project.pages) {
      const target = join(folder, `${page.path || "index"}.md`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bridgePage(page, options.base, noticeLink));
    }
  }
  await writeFile(
    join(options.outputRoot, "index.md"),
    "---\ntitle: Playground\noutline: false\n---\n\n# Playground\n\nThe examples are now interactive.\n\n[Explore the Playground](/playground/)\n",
  );
}
