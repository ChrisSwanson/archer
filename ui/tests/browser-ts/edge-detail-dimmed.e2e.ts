// A dimmed C4 relationship's technology row reads like a dimmed card's `[Container]` line: the faded colour at
// full opacity, not the row's 0.8 on top of the faded colour (2026-10-31: the edge faded twice, the node once).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus");

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

test("a dimmed relationship's technology fades once, as a dimmed card's type line does", async ({ page }) => {
  project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
  const origin = new URL(project.url).origin;
  await page.goto((await project.issueAccess("edge-detail-dimmed")).url);
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${origin}/projects/${slug}/diagrams/containers.mmd?walkthrough=checkout-tour&step=1`);
  await expect(page.locator(".react-flow__edge.archer-dimmed").first()).toBeAttached();
  await expect(page.locator(".react-flow__node.archer-dimmed .archer-c4-type").first()).toBeAttached();
  // A dimmed edge can be drawn before its label plate is: wait for a plate with a technology row (O271).
  type Seen = { edge: { opacity: string; color: string }; node: { opacity: string; color: string }; plate: string };
  let found: Seen | null = null;
  await expect
    .poll(
      async () =>
        (found = await page.evaluate((): Seen | null => {
          const dimmed = new Set(
            [...document.querySelectorAll<SVGGElement>(".react-flow__edge.archer-dimmed")].map((g) => g.dataset.id),
          );
          const plate = [...document.querySelectorAll<HTMLElement>(".archer-edge-label")].find(
            (el) => dimmed.has(el.dataset.edgeId) && el.querySelector(".archer-edge-label-technology") !== null,
          );
          const card = document.querySelector(".react-flow__node.archer-dimmed .archer-c4-type");
          if (plate === undefined || card === null) return null;
          const row = getComputedStyle(plate.querySelector(".archer-edge-label-technology")!);
          const type = getComputedStyle(card);
          return {
            edge: { opacity: row.opacity, color: row.color },
            node: { opacity: type.opacity, color: type.color },
            plate: getComputedStyle(plate).color,
          };
        })) !== null,
    )
    .toBe(true);
  const seen = found as Seen | null;
  if (seen === null) throw new Error("no dimmed label plate");
  expect(seen.edge.opacity).toBe(seen.node.opacity);
  expect(seen.edge.color).toBe(seen.node.color);
  expect(seen.edge.color).toBe(seen.plate);
});
