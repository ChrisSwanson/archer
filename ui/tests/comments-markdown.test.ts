// @vitest-environment jsdom
//
// A note's Markdown is the agent's and the person's own writing, read from the
// repository: rendered as Markdown, never as HTML. Everything that would make
// it markup is shown as text, and no link can run script.
import { describe, expect, it } from "vitest";
import { placeNoteHtml, renderNoteMarkdown } from "../src/comments/markdown";

function render(markdown: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderNoteMarkdown(markdown);
  return host;
}

describe("renderNoteMarkdown", () => {
  it("renders the Markdown a note is written in", () => {
    const host = render(
      "# Auth\n\nTokens *expire*.\n\n- one\n- two\n\n```\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
    );
    expect(host.querySelector("h5.archer-note-h1")?.textContent).toBe("Auth");
    expect(host.querySelector("em")?.textContent).toBe("expire");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.querySelector("pre code")?.textContent).toBe("code\n");
    expect(host.querySelector("table td")?.textContent).toBe("1");
  });

  it("draws a note's headings under the note's own title, never as the page's", () => {
    const host = render("# One\n\n## Two\n\n### Three\n");
    expect([...host.querySelectorAll("h1, h2, h3, h4")]).toEqual([]);
    expect([...host.querySelectorAll("h5, h6")].map((h) => `${h.tagName} ${h.className}`)).toEqual([
      "H5 archer-note-h1",
      "H6 archer-note-h2",
      "H6 archer-note-h3",
    ]);
  });

  it.each([
    "<script>window.pwned = true</script>",
    '<img src="x" onerror="window.pwned = true">',
    '<a href="https://example.com" onclick="window.pwned = true">x</a>',
    '<iframe src="https://example.com"></iframe>',
    "<style>body { display: none }</style>",
  ])("shows raw HTML as text: %s", (html) => {
    const host = render(`Before\n\n${html}\n\nAfter`);
    for (const tag of ["script", "img", "iframe", "style"]) {
      expect(host.querySelector(tag)).toBeNull();
    }
    expect(host.querySelector("[onerror], [onclick]")).toBeNull();
    expect(host.textContent).toContain(html);
  });

  it.each(["javascript:alert(1)", "JAVASCRIPT:alert(1)", "vbscript:msgbox(1)", "data:text/html;base64,PHNjcmlwdD4="])(
    "makes no link of %s",
    (href) => {
      const host = render(`[click](${href})`);
      expect(host.querySelector("a")).toBeNull();
    },
  );

  it("opens a web link away from the page, without handing it the page", () => {
    const link = render("[docs](https://example.com/a)").querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/a");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it.each(["auth-flow.mmd", "//host.example/x", "mailto:a@example.com", "#part"])(
    "keeps a link to %s as its words, so it cannot navigate the page away from the review",
    (href) => {
      const host = render(`[Auth flow](${href})`);
      expect(host.querySelector("a")).toBeNull();
      expect(host.textContent).toContain("Auth flow");
    },
  );
});

describe("images", () => {
  it("shows an image as its words, and fetches nothing", () => {
    const host = render("![the auth flow](https://tracker.example/pixel.png)");
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("the auth flow");
  });
});

describe("placeNoteHtml", () => {
  it("places what markdown-it renders unchanged", () => {
    const host = document.createElement("div");
    const html = renderNoteMarkdown(
      "# A\n\n[x](https://example.com) and `code`\n\n| a |\n|:-:|\n| 1 |\n\n```ts\nlet a\n```\n",
    );
    placeNoteHtml(host, html);
    const expected = document.createElement("div");
    expected.innerHTML = html;
    expect(host.innerHTML).toBe(expected.innerHTML);
  });

  it("keeps only markdown's elements and attributes, whatever it is handed", () => {
    const host = document.createElement("div");
    placeNoteHtml(
      host,
      '<p onclick="x()">Hi<script>window.pwned = 1</script><img src="x" onerror="y()"><a href="javascript:z()" onmouseover="z()">link</a></p>',
    );
    expect(host.querySelector("script, img, [onclick], [onerror], [onmouseover]")).toBeNull();
    expect(host.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(host.textContent).toBe("Hiwindow.pwned = 1link");
  });
});
