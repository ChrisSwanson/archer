export interface DocumentationPage {
  path: string;
  title: string;
  summary: string;
  markdown: string;
}

const origin = "https://chrisswanson.github.io";

/** Publish the same admitted Markdown as the site, without VitePress presentation syntax. */
export function renderLlms(pages: readonly DocumentationPage[], base: string): { index: string; full: string } {
  const root = new URL(`/${base.split("/").filter(Boolean).join("/")}/`.replace(/^\/\/$/, "/"), origin);
  const seen = new Set<string>();
  const documents = pages.map((page) => {
    const url = new URL(page.path, root).href;
    if (seen.has(url)) throw new Error(`duplicate documentation route: ${page.path}`);
    seen.add(url);
    if (!page.summary.trim() || /[\r\n]/.test(page.summary)) throw new Error(`Missing one-line summary: ${page.path}`);
    const markdown = page.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    // Code examples remain byte-for-byte, including comments and presentation-looking syntax.
    const sections = markdown.split(/(^```[^\n]*\n[\s\S]*?^```\s*$)/gm);
    const body = sections
      .map((part, i) =>
        i % 2
          ? part
          : part
              .replace(/<!--[\s\S]*?-->/g, "")
              .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
              .replace(/^::: ?(?:details|tip|info|warning|danger) ?(.*)$/gm, "$1")
              .replace(/^:::\s*$/gm, "")
              .replace(/^<\/?details[^>]*>\s*$/gm, "")
              .replace(/<\/?summary>/g, "")
              .replace(/(\]\()([^\s)]+)(\))/g, (whole, open: string, target: string, close: string) => {
                if (/^(?:[a-z]+:|#)/i.test(target)) return whole;
                const link = target.startsWith("/") ? new URL(target.replace(/^\//, ""), root) : new URL(target, url);
                link.pathname = link.pathname.replace(/\.md$/, "");
                return `${open}${link.href}${close}`;
              }),
      )
      .join("")
      .trim();
    return { ...page, url, body };
  });
  const introduction =
    "# Archer\n\n> Shared visual understanding for people and coding agents. Local Mermaid diagrams and Markdown notes, kept with the code.\n";
  return {
    index: `${introduction}\n## Documentation\n\n${documents.map((page) => `- [${page.title}](${page.url}): ${page.summary}`).join("\n")}\n`,
    full: `${introduction}\n${documents.map((page) => `<!-- Source: ${page.url} -->\n\n${page.body}`).join("\n\n---\n\n")}\n`,
  };
}
