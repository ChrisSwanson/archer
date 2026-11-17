// An open frame's "−" is drawn at a constant screen size (`nesting/toggle-place.ts`), so in drawing units it
// grows as the view zooms out. No caption plate and no wire may sit under it at any zoom the page shows it:
// from Fit of the opened drawing, out by hand to the readable floor (where the controls hide), and in again.
// Found on the Pageturner containers opened at 1500 × 900 (2026-10-31): "Manages orders in [HTTPS]" sat under
// the shop's "−" at the fit zoom (0.65), and its wire ran along the frame's top right under it.
// Nor may a wire run through a frame's caption ("Pageturner Online Booksho|p", Shop Staff to Back Office,
// R7-claude-01) or under another wire's plate (api to payments under "Reads and writes [SQL]" after Fit and
// zooming in, R7-codex-01): both are checked at every zoom too, on the drawn plates and captions.
// Screenshots go to `ARCHER_SHOTS` when it is set.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";
import { settled } from "./support/settled";

const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus");
const SHOTS = process.env.ARCHER_SHOTS;

function corpus(name: string): Record<string, string> {
  const root = join(CORPUS, name);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}
const commit = async (root: string): Promise<void> => {
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      ["-c", "user.name=archer-test", "-c", "user.email=test@archer.invalid", "-c", "init.defaultBranch=main", ...args],
      {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
  };
  git("init");
  git("add", "-A");
  git("commit", "-m", "corpus");
};

let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

/** What sits under an open frame's "−" on screen (plates, wires sampled along each drawn path), and wires through a frame's caption or another wire's plate. */
async function underToggles(page: Page): Promise<{ zoom: number; toggles: number; faults: string[] }> {
  return page.evaluate(() => {
    const zoom = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    const toggles = [...document.querySelectorAll<HTMLElement>(".archer-nest-toggle-open")].map((el) => ({
      id: el.dataset.nestToggle!,
      box: el.getBoundingClientRect(),
    }));
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const within = (x: number, y: number, b: DOMRect) =>
      x > b.left + 0.5 && x < b.right - 0.5 && y > b.top + 0.5 && y < b.bottom - 0.5;
    const faults: string[] = [];
    for (const plate of document.querySelectorAll<HTMLElement>(".archer-edge-label")) {
      const box = plate.getBoundingClientRect();
      for (const toggle of toggles)
        if (hit(box, toggle.box)) faults.push(`caption ${plate.dataset.edgeId} under ${toggle.id}'s −`);
    }
    const captions = [...document.querySelectorAll<HTMLElement>(".archer-frame-caption")].map((el) => ({
      text: el.textContent ?? "",
      box: el.getBoundingClientRect(),
    }));
    const plates = [...document.querySelectorAll<HTMLElement>(".archer-edge-label")].map((el) => ({
      id: el.dataset.edgeId!,
      box: el.getBoundingClientRect(),
    }));
    for (const edge of document.querySelectorAll<SVGGElement>(".react-flow__edge")) {
      const path = edge.querySelector<SVGPathElement>("path.react-flow__edge-path");
      if (path === null) continue;
      const matrix = path.getScreenCTM();
      if (matrix === null) continue;
      const length = path.getTotalLength();
      const points: DOMPoint[] = [];
      for (let at = 0; at <= length; at += 2)
        points.push(new DOMPoint(path.getPointAtLength(at).x, path.getPointAtLength(at).y).matrixTransform(matrix));
      const crosses = (box: DOMRect) => points.some((p) => within(p.x, p.y, box));
      for (const toggle of toggles)
        if (crosses(toggle.box)) faults.push(`wire ${edge.dataset.id} under ${toggle.id}'s −`);
      for (const caption of captions)
        if (crosses(caption.box)) faults.push(`wire ${edge.dataset.id} through caption "${caption.text}"`);
      for (const plate of plates)
        if (plate.id !== edge.dataset.id && crosses(plate.box))
          faults.push(`wire ${edge.dataset.id} under ${plate.id}'s plate`);
    }
    return { zoom, toggles: toggles.length, faults };
  });
}

const CASES = [
  { corpus: "pageturner", diagram: "containers.mmd", open: ["Pageturner Online Bookshop"] },
  { corpus: "awkward", diagram: "c4-boundaries.mmd", open: ["Example Corp", "Web shop", "Operations"] },
];

for (const item of CASES) {
  for (const width of [1500, 1000]) {
    test(`no plate or wire under an open frame's −, no wire through a caption or another wire's plate, at any shown zoom: ${item.diagram} at ${width}`, async ({
      page,
    }) => {
      project = await sharedTsProject({ files: corpus(item.corpus), beforeAttach: commit });
      const origin = new URL(project.url).origin;
      await page.goto((await project.issueAccess("toggle-clear")).url);
      const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${origin}/projects/${slug}/diagrams/${item.diagram}`);
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      for (const name of item.open) {
        await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
        await expect(page.getByRole("button", { name: `Close ${name}`, exact: true })).toBeVisible();
        await settled(page);
      }
      await page.getByRole("button", { name: "Fit view", exact: true }).first().click();
      await settled(page);
      const stem = `${item.diagram.replace(/\.mmd$/, "")}-open-${width}`;
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${stem}-fit.png`) });
      const seen: { zoom: number; faults: string[] }[] = [await underToggles(page)];
      // A fit too small to read hides the controls (1000 wide): in by hand until they show, the smallest zoom they show at.
      for (let step = 0; step < 6 && (await underToggles(page)).toggles === 0; step++) {
        await page.getByRole("button", { name: "Zoom in", exact: true }).first().click();
        await settled(page);
      }
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${stem}-shown.png`) });
      const first = await underToggles(page);
      expect(first.toggles, "every opened frame shows its −").toBe(item.open.length);
      seen.push(first);
      // Out by hand while the controls still show (they hide below the readable floor).
      for (let step = 0; step < 6; step++) {
        await page.getByRole("button", { name: "Zoom out", exact: true }).first().click();
        await settled(page);
        const at = await underToggles(page);
        if (at.toggles === 0) break;
        seen.push(at);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${stem}-out${step + 1}.png`) });
      }
      // And in again past the fit, to the size a diagram is read at and beyond.
      await page.getByRole("button", { name: "Fit view", exact: true }).first().click();
      await settled(page);
      for (let step = 0; step < 3; step++) {
        await page.getByRole("button", { name: "Zoom in", exact: true }).first().click();
        await settled(page);
        seen.push(await underToggles(page));
      }
      expect(
        seen.filter((s) => s.faults.length > 0).map((s) => `zoom ${s.zoom.toFixed(2)}: ${s.faults.join("; ")}`),
      ).toEqual([]);
    });
  }
}
