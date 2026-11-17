// The rename plan on sandbox copies of real projects (ADR 0036 §10, A14): opt-in, since the
// projects whose walkthroughs name element ids are private and never checked in. Set
// ARCHER_RENAME_SANDBOXES to a ":"-separated list of project folders; each is copied to a temporary
// folder first, so the copy given is never written. Per project the plan renames the report's
// possible duplicates (survivor rule) and every element id a walkthrough names, applies it, and
// checks that every walkthrough reads as it did and every diagram still compiles.
import { cpSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication, type Application } from "../../src/application/index.ts";
import { ProjectModelCache } from "../../src/application/project-model.ts";
import { applyRenamePlan, planRenames, suggestedEntries, type RenameEntry } from "../../src/application/rename-plan.ts";
import { findProject } from "../../src/project/index.ts";
import type { Walkthrough } from "../../src/walkthroughs/contract.ts";
import { cleanUp, tempDir } from "../service/support.ts";

afterEach(cleanUp);

const sandboxes = (process.env["ARCHER_RENAME_SANDBOXES"] ?? "").split(":").filter((p) => p !== "");

async function walkthroughs(
  app: Application,
  views: readonly string[],
): Promise<Map<string, { status: string; ids: string[] }>> {
  const out = new Map<string, { status: string; ids: string[] }>();
  for (const viewId of views) {
    const listed = await app.call("list_walkthroughs", { viewId }).catch((e: Error) => {
      process.stderr.write(`list_walkthroughs ${viewId}: ${e.message}\n`);
      return null;
    });
    for (const item of (listed?.structured.walkthroughs as { id: string; status: string }[] | undefined) ?? []) {
      const one = await app.call("list_walkthroughs", { viewId, id: item.id });
      const w = one.structured.walkthrough as Walkthrough;
      const ids = w.steps.flatMap((s) => [
        ...(s.nodes ?? []).map((n) => n.id),
        ...(s.messages ?? []).flatMap((m) => [m.from, m.to]),
      ]);
      out.set(`${viewId}/${item.id}`, { status: item.status, ids });
    }
  }
  return out;
}

// With none given, one skipped test: a file that defines no test fails the suite.
if (sandboxes.length === 0) test.skip("sandbox: set ARCHER_RENAME_SANDBOXES to run", () => {});
else
  test.each(sandboxes)(
    "sandbox %s: renamed, every walkthrough reads as it did",
    async (given) => {
      const cwd = join(tempDir("archer-rename-sandbox-"), basename(given));
      cpSync(given, cwd, { recursive: true });
      const app = createApplication({ cwd });
      try {
        const project = findProject(cwd);
        const { model, inputs } = await new ProjectModelCache().build(project);
        const views = inputs.map((v) => v.id);
        const before = await walkthroughs(app, views);
        // The point of the run: a project whose walkthroughs name element ids.
        expect(before.size, "walkthroughs found").toBeGreaterThan(0);
        const indexed = new Set(model.index.map((e) => e.id));
        // The report's duplicates, then every element id a walkthrough names (so each walkthrough is rewritten).
        const entries: RenameEntry[] = [];
        const from = new Set<string>(),
          to = new Set<string>();
        const add = (e: RenameEntry) => {
          if (!from.has(e.from) && !to.has(e.from) && !from.has(e.to)) {
            entries.push(e);
            from.add(e.from);
            to.add(e.to);
          }
        };
        for (const e of suggestedEntries(model)) add(e);
        // A walkthrough's id that is no element (an unkinded node) is renamed in its own view only.
        for (const [key, w] of before)
          for (const id of w.ids)
            add(
              indexed.has(id)
                ? { from: id, to: `${id}Rn` }
                : { from: id, to: `${id}Rn`, views: [key.slice(0, key.lastIndexOf("/"))] },
            );
        let plan = await planRenames(app, project, entries);
        // Entries the dry run refuses are dropped and reported, as the agent would leave them out of the offer.
        const dropped = plan.problems;
        if (!plan.ready)
          plan = await planRenames(
            app,
            project,
            entries.filter((e) => !dropped.some((p) => p.entry === e)),
          );
        process.stderr.write(
          `${basename(given)}: ${entries.length} entries, ${plan.entries.length} planned, ${plan.writes.length} writes (${plan.writes.filter((w) => w.kind === "walkthrough").length} walkthroughs); dropped: ${dropped.map((p) => `${p.viewId ?? ""} ${p.problem}`).join(" | ") || "none"}; before ${JSON.stringify(plan.before)}; after ${JSON.stringify(plan.after)}\n`,
        );
        expect(plan.ready).toBe(true);
        expect(plan.writes.filter((w) => w.kind === "walkthrough").length, "walkthroughs rewritten").toBeGreaterThan(0);
        const run = await applyRenamePlan(app, plan);
        if (!run.completed) process.stderr.write(`${run.text}\n`);
        expect(run.text).toMatch(/^Rename plan applied/);
        const after = await walkthroughs(app, views);
        expect([...after.entries()].map(([k, v]) => [k, v.status])).toEqual(
          [...before.entries()].map(([k, v]) => [k, v.status]),
        );
        for (const v of views)
          expect((await app.call("read_diagram", { viewId: v })).structured.envelope, v).not.toBeNull();
      } finally {
        app.close();
      }
    },
    120_000,
  );
