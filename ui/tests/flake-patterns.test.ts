// Test-code patterns that read the page one step too early. Each passed on a quiet machine and
// failed only under CI load (known failures O21, O22, O25), so they are refused here, in the
// unit gate CI and `npm run pr-check` both run, rather than found on a runner.
//
// A line that is right as written carries `// flake-check: ok — <reason>`, on the line itself or
// alone on the line above.
//
// Not checked: a click right after an expand/open click. O24 (chat-bubble.e2e) waited for
// `toBeVisible` between the two and still flaked mid-transition, so no textual rule separates
// the safe case from the unsafe one; `settled(page)` is the convention there.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Hit = { line: number; rule: string };

const RULES = {
  findThenGet:
    "within(<container>).getBy… just after `await screen.findBy…` — the container can show before its content (O25); use findBy… on the content",
  pageEvent:
    "waitForEvent(\"page\") — the context's page event did not fire on a loaded runner (O22); wait for the new tab's navigation request",
  oneShotEvaluateAll:
    "one-shot evaluateAll(…) read straight into expect(…) — it can run before the rows fill (O21); use expect.poll",
} as const;

const OK = /flake-check: ok/;

function scan(source: string): Hit[] {
  const lines = source.split("\n");
  const hits: Hit[] = [];
  const silenced = (index: number) =>
    OK.test(lines[index]) || (index > 0 && /^\s*\/\/\s*flake-check: ok/.test(lines[index - 1]));
  const add = (index: number, rule: keyof typeof RULES) => {
    if (!silenced(index)) hits.push({ line: index + 1, rule: RULES[rule] });
  };

  // Functions that return a one-shot evaluateAll: `const f = async () => x.evaluateAll(` or a
  // `function f(` / `const f = (` whose `return x.evaluateAll(` follows within three lines.
  const helpers = new Set<string>();
  lines.forEach((text, index) => {
    if (!text.includes(".evaluateAll(")) return;
    const arrow = /\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)[^=]*=>/.exec(text);
    if (arrow) {
      helpers.add(arrow[1]);
      return;
    }
    if (!/^\s*return\b/.test(text)) return;
    for (let back = index - 1; back >= Math.max(0, index - 3); back--) {
      const named = /\bfunction\s+(\w+)\s*\(|\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/.exec(lines[back]);
      if (named) {
        helpers.add(named[1] ?? named[2]);
        return;
      }
    }
  });

  lines.forEach((text, index) => {
    // (a) A container found by findBy…, then read synchronously within the next two lines.
    const found = /\b(\w+)\s*=\s*await\s+screen\.findBy\w*\(/.exec(text);
    if (found) {
      const within = new RegExp(`within\\(\\s*${found[1]}\\s*\\)\\.get(?:All)?By\\w*\\(`);
      for (let next = index + 1; next <= index + 2 && next < lines.length; next++) {
        const match = within.exec(lines[next]);
        // Inside a waitFor (it retries the read) that opens on this line or one between: not a one-shot read.
        const before = [...lines.slice(index + 1, next), lines[next].slice(0, match?.index ?? 0)].join("\n");
        if (match && !/waitFor\(/.test(before)) add(next, "findThenGet");
      }
    }
    // (b) The context's page event.
    if (/waitForEvent\(\s*["'`]page["'`]/.test(text)) add(index, "pageEvent");
    // (c) A one-shot evaluateAll whose result is asserted at once.
    if (/\bexpect(?:\.soft)?\(\s*await\b[^;]*\.evaluateAll\(/.test(text)) add(index, "oneShotEvaluateAll");
    const stored = /\b(?:const|let)\s+(\w+)\s*=\s*await\b.*\.evaluateAll\(/.exec(text);
    if (stored) {
      const asserted = new RegExp(`\\bexpect(?:\\.soft)?\\(\\s*${stored[1]}\\b`);
      if (lines.slice(index + 1, index + 5).some((line) => asserted.test(line))) add(index, "oneShotEvaluateAll");
    }
    for (const helper of helpers) {
      if (new RegExp(`\\bexpect(?:\\.soft)?\\(\\s*await\\s+${helper}\\(`).test(text)) add(index, "oneShotEvaluateAll");
    }
  });
  return hits;
}

describe("flake patterns", () => {
  it("would have flagged O25: the README card read synchronously after findBy", () => {
    const o25 = [
      `const card = await screen.findByRole("region", { name: /README/ });`,
      `expect(within(card).getByText("The shop's readme.")).toBeInTheDocument();`,
    ].join("\n");
    expect(scan(o25)).toEqual([{ line: 2, rule: RULES.findThenGet }]);
    // The same read inside a waitFor that a formatter opened on the line before is retried, not one-shot.
    const wrapped = [
      `const grid = await screen.findByRole("treegrid", { name: "Project files" });`,
      `await waitFor(() =>`,
      `  expect(within(grid).getByRole("button", { name: /Shop/ })).toHaveAttribute("aria-expanded", "true"),`,
    ].join("\n");
    expect(scan(wrapped)).toEqual([]);
    expect(scan(o25.replace("within(card).getByText", "await within(card).findByText"))).toEqual([]);
    // Inside waitFor it is retried, so it is not one-shot.
    expect(
      scan(
        `const grid = await screen.findByRole("grid");\nawait waitFor(() => expect(within(grid).getByRole("button")).toBeVisible());`,
      ),
    ).toEqual([]);
    // Only the two lines after the findBy.
    expect(scan(`const card = await screen.findByRole("region");\na();\nb();\nwithin(card).getByText("x");`)).toEqual(
      [],
    );
  });

  it("would have flagged O22: the context's page event", () => {
    expect(scan(`const popup = page.context().waitForEvent("page");`)).toEqual([{ line: 1, rule: RULES.pageEvent }]);
    expect(scan(`const opened = page.context().waitForEvent("request", (r) => r.isNavigationRequest());`)).toEqual([]);
  });

  it("would have flagged O21: folder rows read once by evaluateAll", () => {
    const o21 = [
      `const folderNames = async (): Promise<string[]> => treeOf(page).locator("[data-folder]").evaluateAll((rows) => rows.map((row) => row.dataset.folder ?? ""));`,
      `expect(await folderNames()).toEqual(["diagrams", "notes"]);`,
    ].join("\n");
    expect(scan(o21)).toEqual([{ line: 2, rule: RULES.oneShotEvaluateAll }]);
    expect(scan(o21.replace("expect(await folderNames())", "await expect.poll(folderNames)"))).toEqual([]);
    expect(scan(`expect(await rows.evaluateAll((all) => all.length)).toBe(2);`)).toEqual([
      { line: 1, rule: RULES.oneShotEvaluateAll },
    ]);
    expect(
      scan(`const links = await rows.evaluateAll((all) => all.map(String));\nexpect(links).toHaveLength(5);`),
    ).toEqual([{ line: 1, rule: RULES.oneShotEvaluateAll }]);
    expect(
      scan(
        `async function openSet(page) {\n  return page.locator("x").evaluateAll((all) => all.length);\n}\nexpect(await openSet(page)).toEqual(1);`,
      ),
    ).toEqual([{ line: 4, rule: RULES.oneShotEvaluateAll }]);
  });

  it("is silenced by a reasoned escape comment on the line or alone above it", () => {
    expect(
      scan(
        `expect(await rows.evaluateAll((all) => all.length)).toBe(2); // flake-check: ok — read after the poll above`,
      ),
    ).toEqual([]);
    expect(
      scan(
        `// flake-check: ok — the rows were polled above\nexpect(await rows.evaluateAll((all) => all.length)).toBe(2);`,
      ),
    ).toEqual([]);
  });

  it("finds none of them in ui/tests", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const self = fileURLToPath(import.meta.url);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mts)$/.test(entry.name) && path !== self) files.push(path);
      }
    };
    walk(root);
    const found = files.flatMap((file) =>
      scan(readFileSync(file, "utf8")).map((hit) => `${relative(root, file)}:${hit.line}: ${hit.rule}`),
    );
    expect(found).toEqual([]);
  });
});
