// Amber (`--agent*`) is the agent's voice and nothing else (styles.css, "THE TWO VOICES").
//
// It leaked: open-thread counts, the Source panel's problem count and the editor's warning marks all
// wore amber, so a reader could not tell "the agent said this" from "there are 3 open threads" or
// "this line has a warning". This guard reads every stylesheet under `src/` and fails on any rule
// that paints with an `--agent` token without saying, in its selector, that it is the agent speaking.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesOf } from "./stylesheet";

const SRC = resolve(process.cwd(), "src");
const AGENT_TOKEN = /var\(--agent(?:-[\w-]+)?\)/;

/** A selector that names the agent: `[data-author="agent"]`, `[data-voice="agent"]`, `.archer-pin-agent`, `--agent`. */
const NAMES_THE_AGENT = /agent/;

/**
 * Agent-voice rules whose selector does not carry the word. Each says why it is the agent speaking.
 * Keep it short: an entry is a promise that this element only ever stands for the agent.
 */
const AGENT_VOICE_WITHOUT_THE_WORD: ReadonlyArray<{ file: string; selector: string; why: string }> = [
  { file: "styles.css", selector: '.archer-thread-status[data-status="answered"]', why: "the agent answered" },
  { file: "styles.css", selector: '.archer-thread-status[data-status="resolved"]', why: "the agent resolved it" },
  { file: "styles.css", selector: ".archer-comment-glyph", why: "the agent's mark on a reply" },
  { file: "styles.css", selector: ".archer-caption-by", why: "the agent's caption byline" },
  { file: "styles.css", selector: "22%", why: "the change pulse keyframes: the agent's change swelling in" },
];

/** Rules that are counts, problems or warnings: never the agent's voice, whatever the selector says. */
const NEVER_THE_AGENT: ReadonlyArray<{ file: string; selector: string }> = [
  { file: "app/ProjectTitle.css", selector: '.archer-project-fact-value[data-open="true"]' },
  { file: "app/project-views/project-views.css", selector: '.archer-project-view-threads[data-open="true"]' },
  { file: "app/FolderTree.css", selector: '.archer-folder-tree-threads[data-open="true"]' },
  { file: "app/SourcePanel.css", selector: ".archer-source-panel-problems" },
  { file: "source-editor/source-editor.css", selector: ".archer-mermaid-editor .cm-mmd-directive" },
  { file: "source-editor/source-editor.css", selector: ".archer-mermaid-editor .cm-editor .cm-lintRange-warning" },
  { file: "source-editor/source-editor.css", selector: ".archer-mermaid-editor .cm-editor .cm-lint-marker-warning" },
  { file: "source-editor/source-editor.css", selector: ".archer-mermaid-editor .cm-editor .cm-diagnostic-warning" },
];

/** The rules that define tokens rather than consume them. */
const TOKEN_BLOCK = /^:root/;

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

function rulesIn(file: string) {
  return rulesOf(read(join(SRC, file)));
}

describe("amber is the agent's voice only", () => {
  it("no rule paints with an --agent token unless its selector is the agent speaking", () => {
    const offenders: string[] = [];
    for (const path of cssFiles(SRC)) {
      const file = relative(SRC, path);
      for (const rule of rulesOf(read(path))) {
        if (!AGENT_TOKEN.test(rule.body)) continue;
        for (const selector of rule.selectors) {
          if (TOKEN_BLOCK.test(selector) || NAMES_THE_AGENT.test(selector)) continue;
          if (AGENT_VOICE_WITHOUT_THE_WORD.some((entry) => entry.file === file && entry.selector === selector))
            continue;
          offenders.push(`${file}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(NEVER_THE_AGENT)("$file $selector is neutral or a problem colour, not amber", ({ file, selector }) => {
    const rules = rulesIn(file).filter((rule) => rule.selectors.includes(selector));
    expect(rules.length, `${selector} not found in ${file}`).toBeGreaterThan(0);
    for (const rule of rules) expect(rule.body).not.toMatch(AGENT_TOKEN);
  });

  it("an error count is the danger colour; a warnings-only count is neutral", () => {
    const panel = rulesIn("app/SourcePanel.css");
    const body = (selector: string) => panel.find((rule) => rule.selectors.includes(selector))?.body ?? "";
    expect(body(".archer-source-panel-problems")).toMatch(/color:\s*var\(--text-dim\)/);
    expect(body(".archer-source-panel-problems.has-errors")).toMatch(/color:\s*var\(--danger-text\)/);
  });
});
