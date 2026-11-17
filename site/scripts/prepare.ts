import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { siteBase } from "../site.config.ts";
import { guideDocuments } from "./documents.mts";
import { generateCliReference } from "./cli-reference.mts";
import { mermaidFamilies, mermaidPages } from "./mermaid-pages.mts";
import { renderLlms, type DocumentationPage } from "./llms.mts";
import { buildPlayground } from "./playground-build.mts";
import { listExampleProjects, writePlaygroundBridges } from "./playground-bridges.mts";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const publicRepository = "https://github.com/chrisswanson/archer/blob/main/";

/** Published documents stay local; other relative links target the public repository. */
export function sourceDocument(markdown: string, sourcePath: string): string {
  return markdown.replace(/(\]\()([^\s)]+)(\))/g, (whole, open: string, target: string, close: string) => {
    if (/^(?:[a-z]+:|\/|#)/i.test(target)) return whole;
    const [path, fragment = ""] = target.split("#");
    const source = posix.normalize(posix.join(posix.dirname(sourcePath), path!));
    const published = guideDocuments.find((document) => document.source === source);
    const destination = published
      ? `/${published.path}`
      : source === "ts/docs/supported-mermaid.md"
        ? "/supported-mermaid/"
        : `${publicRepository}${source}`;
    return `${open}${destination}${fragment ? `#${fragment}` : ""}${close}`;
  });
}

interface PrepareOptions {
  repoRoot?: string;
  siteRoot?: string;
}

/** Everything VitePress reads except the Playground app: guides, references, Examples bridges and llms.txt. */
export async function prepareDocs(options: PrepareOptions = {}): Promise<void> {
  const repoRoot = options.repoRoot ?? checkout;
  const siteRoot = options.siteRoot ?? join(repoRoot, "site");
  const generated = join(siteRoot, "generated");
  // Removed examples cannot leave stale pages.
  await rm(generated, { recursive: true, force: true });
  await mkdir(generated, { recursive: true });
  // The retired gallery's SVGs and drawing cache must disappear even in a previously prepared checkout.
  await rm(join(siteRoot, "public/generated"), { recursive: true, force: true });
  await rm(join(siteRoot, ".cache/diagrams"), { recursive: true, force: true });
  // Removed references must disappear even in a previously prepared checkout.
  await rm(join(siteRoot, "security/known-limits.md"), { force: true });
  await rm(join(siteRoot, "security/index.md"), { force: true });
  await rm(join(siteRoot, "supported-mermaid"), { recursive: true, force: true });
  // The overview was supported-mermaid.md beside its folder; a page and a folder of one name are ambiguous on a static host.
  await rm(join(siteRoot, "supported-mermaid.md"), { force: true });
  const documents: DocumentationPage[] = [];
  for (const document of guideDocuments) {
    const markdown = sourceDocument(await readFile(join(repoRoot, document.source), "utf8"), document.source);
    if (!document.source.startsWith("site/")) {
      const target = join(siteRoot, `${document.path}.md`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `<!-- Generated from ${document.source}; edit the source document. -->\n\n${markdown}`);
    }
    documents.push({ ...document, markdown });
  }
  const profile = mermaidPages(await readFile(join(repoRoot, "ts/docs/supported-mermaid.md"), "utf8"));
  for (const [path, markdown] of Object.entries(profile)) {
    const target = join(siteRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, markdown);
    const family = mermaidFamilies.find((item) => path === `supported-mermaid/${item.slug}.md`);
    documents.push({
      path: path.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, ""),
      title: family?.title ?? (path === "supported-mermaid/index.md" ? "Supported Mermaid" : "Shared Mermaid rules"),
      summary:
        family?.purpose ??
        (path === "supported-mermaid/index.md"
          ? "Choose a diagram family and find its accepted syntax."
          : "Limits, nesting, label entities and diagnostics across diagram families."),
      markdown,
    });
  }
  const cli = await generateCliReference(repoRoot);
  await writeFile(join(generated, "cli.md"), cli);
  documents.splice(4, 0, {
    path: "generated/cli",
    title: "CLI reference",
    summary: "Command synopses, options, examples and nested subcommands from CLI declarations.",
    markdown: cli,
  });
  await writePlaygroundBridges({
    outputRoot: join(generated, "examples"),
    base: siteBase,
    projects: await listExampleProjects(join(repoRoot, "examples")),
  });
  documents.push({
    path: "using-the-playground",
    title: "Using the Playground",
    summary: "Explore real Archer projects, diagrams, notes and saved walkthroughs in your browser.",
    markdown: await readFile(join(repoRoot, "site/using-the-playground.md"), "utf8"),
  });
  const llms = renderLlms(documents, siteBase);
  await mkdir(join(siteRoot, "public"), { recursive: true });
  await writeFile(join(siteRoot, "public/llms.txt"), llms.index);
  await writeFile(join(siteRoot, "public/llms-full.txt"), llms.full);
}

export async function prepareSite(options: PrepareOptions = {}): Promise<void> {
  const repoRoot = options.repoRoot ?? checkout;
  const siteRoot = options.siteRoot ?? join(repoRoot, "site");
  await prepareDocs({ repoRoot, siteRoot });
  await buildPlayground({ repoRoot, siteRoot });
  console.info(`Documentation prepared at ${siteRoot}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSite().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
