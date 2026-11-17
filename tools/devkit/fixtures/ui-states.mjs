#!/usr/bin/env node
/** Reproducible R1 state fixtures, using sandbox.mjs ownership and cleanup.
 * Standalone: node tools/devkit/fixtures/ui-states.mjs --page /path/to/index.html --out /tmp/states
 * Harness CLI: ARCHER_UI_STATES_PAGE=/path/to/index.html node tools/devkit/harness/smoke.mjs --sandbox <name> --journey tools/devkit/fixtures/ui-states.mjs
 * Harness API: const kit=await createStateFixtures({page}); try { const f=await kit.setup('compile-error');
 * await withPage(async ({page})=>{await page.goto(f.url);await measureState(page,f,{out});},{sandbox:kit.forHarness(f)});
 * } finally { await kit.close(); }
 * Reader is an ordinary access link; it can edit under the current policy. No fake read-only role.
 * Access grants have no time-expiry contract. expired-link is a real issued/revoked unavailable link;
 * output explicitly marks time-expiry unsupported, so it cannot certify an actual expired-link gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, expect } from "@playwright/test";
import { REPO, up, down, issueLink, sandboxEnv } from "../sandbox.mjs";

export const STATE_NAMES = ["zero-projects", "compile-error", "expired-link", "reader-link", "service-stopped"];
const CONTROL = `import {createApplication} from './ts/src/application/index.ts'; import {connectIfRunning,ensureService} from './ts/src/service/client.ts'; const input=JSON.parse(process.argv[1]);const app=createApplication({cwd:process.cwd(),findService:()=>connectIfRunning({env:process.env}),ensureService:()=>ensureService({env:process.env})});try { const answer=await app.call(input.name,input.args);process.stdout.write(JSON.stringify(answer.structured)+'\\n');}finally{app.close();}`;
function control(record, name, args = {}) {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", CONTROL, JSON.stringify({ name, args })],
    { cwd: REPO, env: sandboxEnv(record), encoding: "utf8", timeout: 20000 },
  );
  if (r.status !== 0) throw new Error(`${name}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

/** Fixture setup never reads or changes the shared sandbox. Its owned sandbox is removed in close(). */
export async function createStateFixtures({ name = `r1-states-${process.pid}-${Date.now().toString(36)}`, page } = {}) {
  const pagePath = resolve(page ?? process.env.ARCHER_UI_STATES_PAGE ?? join(REPO, "ui/dist/index.html"));
  if (!existsSync(pagePath))
    throw new Error(
      `No built page at ${pagePath}; pass --page with an existing build. This tool never builds product code.`,
    );
  const scratch = mkdtempSync(join(tmpdir(), "archer-ui-states-"));
  const previousWriters = process.env.ARCHER_WRITERS_DIR;
  process.env.ARCHER_WRITERS_DIR = join(scratch, "writers");
  let sandbox;
  try {
    sandbox = await up({ name, corpus: join(REPO, "tools/devkit/corpus/journeys"), page: pagePath });
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  } finally {
    if (previousWriters === undefined) delete process.env.ARCHER_WRITERS_DIR;
    else process.env.ARCHER_WRITERS_DIR = previousWriters;
  }
  // Control processes get exactly the same private writer directory as the service.
  const project = sandbox.projects[0],
    file = join(project.root, ".archer/diagrams/flow.mmd"),
    original = readFileSync(file, "utf8");
  let detached = false,
    stopped = false,
    closed = false;
  const ctl = (operation, args) => {
    const previous = process.env.ARCHER_WRITERS_DIR;
    process.env.ARCHER_WRITERS_DIR = join(scratch, "writers");
    try {
      return control(sandbox, operation, args);
    } finally {
      if (previous === undefined) delete process.env.ARCHER_WRITERS_DIR;
      else process.env.ARCHER_WRITERS_DIR = previous;
    }
  };
  return {
    sandbox,
    forHarness(fixture) {
      return { ...sandbox, link: fixture.login };
    },
    async setup(state) {
      if (!STATE_NAMES.includes(state)) throw new Error(`Unknown state ${state}`);
      if (stopped) throw new Error("service-stopped is terminal; create another fixture kit for further states");
      if (detached) {
        ctl("attach_project", { root: project.root });
        detached = false;
      }
      writeFileSync(file, original);
      const common = {
        name: state,
        role: "editor",
        mode: "overview",
        surface: "P1",
        login: sandbox.link,
        url: `${sandbox.origin}/projects/`,
        stateDir: sandbox.stateDir,
        projectRoot: project.root,
        privateWritersDir: join(scratch, "writers"),
        page: pagePath,
      };
      if (state === "zero-projects") {
        ctl("detach_project", { root: project.root });
        detached = true;
        return { ...common, projectCount: ctl("list_projects", {}).projects.length };
      }
      if (state === "expired-link") {
        const link = issueLink({ name: sandbox.name, reader: true, label: "R1 unavailable-link fixture" });
        const revocation = ctl("revoke_access_link", { grantId: link.id });
        return {
          ...common,
          role: "unauthenticated",
          mode: "access-refused",
          surface: "P9",
          login: link.url,
          url: link.url,
          grantId: link.id,
          revoked: revocation.revoked,
          timeExpirySupported: false,
          limitation:
            "Access grants have no expiresAt or TTL. A real issued then revoked grant exercises the unavailable-link page; actual time expiration is unmeasured.",
        };
      }
      const url = `${sandbox.origin}/projects/${project.slug}/diagrams/flow.mmd`;
      if (state === "reader-link") {
        const link = issueLink({ name: sandbox.name, reader: true, label: "R1 reader fixture" });
        return {
          ...common,
          role: "reader",
          mode: "explore",
          surface: "P4",
          login: link.url,
          url,
          grantId: link.id,
          mayEdit: true,
          authoringRoots: [],
          roleNote: "Ordinary reader links may edit unless project archer.toml sets edit=false.",
        };
      }
      if (state === "compile-error") {
        writeFileSync(file, "flowchart LR\n  a[Client]\n  a --> missing\n");
        return {
          ...common,
          mode: "compile-error",
          surface: "P4",
          url,
          file,
          compileInvalid: true,
          plantedSource: "flowchart LR\\n  a[Client]\\n  a --> missing\\n",
        };
      }
      return {
        ...common,
        mode: "explore-stale",
        surface: "P4",
        url,
        stop: async () => {
          ctl("stop_service", {});
          stopped = true;
        },
        get stopped() {
          return stopped;
        },
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await down({ name: sandbox.name });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}

/** Rendered outcome checker. Kept separate so planted fixtures prove both a pass and a refusal. */
export async function inspectState(page, fixture) {
  const rendered = await page.evaluate(() => {
    const visible = (el) => {
      const s = getComputedStyle(el),
        r = el.getBoundingClientRect();
      return (
        s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0 && Number(s.opacity) !== 0
      );
    };
    const live = [...document.querySelectorAll('[role="alert"],[role="status"],[aria-live]')]
      .filter(visible)
      .map((el) => ({
        role: el.getAttribute("role"),
        live: el.getAttribute("aria-live"),
        text: el.innerText ?? el.textContent ?? "",
      }));
    return {
      text: document.body.innerText,
      live,
      activeElement: document.activeElement?.tagName ?? null,
      heading: [...document.querySelectorAll("h1,h2")].filter(visible).map((el) => el.textContent),
      diagramReady: [
        ...document.querySelectorAll(".react-flow__node, .archer-seq-participant, .archer-figure-node"),
      ].some(visible),
      editing: !!document.querySelector(".authoring-workspace"),
      editButtons: [...document.querySelectorAll("button")]
        .filter(visible)
        .filter((el) => el.textContent?.trim() === "Edit").length,
    };
  });
  const failures = [];
  const require = (condition, why) => {
    if (!condition) failures.push(why);
  };
  if (fixture.name === "zero-projects") {
    require(fixture.projectCount === 0, "empty overview fixture must have zero attached projects");
    require(/no projects|nothing here|no attached|no content yet|no diagrams or notes yet/i.test(
      rendered.text,
    ), "empty overview must state it is empty");
    require(/ask.*agent|attach.*project|add.*project/i.test(rendered.text), "empty overview must say how to continue");
  } else if (fixture.name === "compile-error") {
    require(fixture.compileInvalid === true, "fixture must plant invalid Mermaid");
    require(rendered.live.some((l) =>
      /compil|invalid.*mermaid|diagram.*could not/i.test(l.text),
    ), "compile error must be visible in a live region");
  } else if (fixture.name === "expired-link") {
    require(fixture.revoked === true, "unavailable-link fixture must revoke a real grant");
    require(/open the link archer gave you/i.test(rendered.text) &&
      /new one|new link/i.test(rendered.text), "unavailable link must explain how to recover");
  } else if (fixture.name === "reader-link") {
    require(fixture.role === "reader" &&
      !!fixture.grantId, "reader fixture must issue a separate ordinary reader grant");
    require(!/open the link archer gave you/i.test(rendered.text) &&
      rendered.diagramReady &&
      /client/i.test(rendered.text) &&
      /api/i.test(rendered.text), "reader must reach the rendered diagram, not stop at a loading title");
    require(!rendered.editing, "reader fixture starts in Explore, not Edit");
  } else if (fixture.name === "service-stopped") {
    require(fixture.stopped === true, "service must actually stop after page load");
    require(rendered.live.some((l) =>
      /reconnect|out of date|connection|unavailable/i.test(l.text),
    ), "stopped service must announce stale/unavailable state");
  } else throw new Error(`Unknown state ${fixture.name}`);
  return { ok: failures.length === 0, failures, url: page.url(), ...rendered };
}

/** Import in a harness step to retain exact URL, role, mode, visible messages and a screenshot. */
export async function measureState(page, fixture, { out } = {}) {
  const result = {
    ...Object.fromEntries(Object.entries(fixture).filter(([, v]) => typeof v !== "function")),
    observed: await inspectState(page, fixture),
  };
  if (out) {
    mkdirSync(out, { recursive: true });
    result.screenshot = join(resolve(out), `${fixture.name}.png`);
    await page.screenshot({ path: result.screenshot });
  }
  return result;
}

export async function runStateFixtures({ out, devUrl, page, name, browser: suppliedBrowser } = {}) {
  out = resolve(out ?? join(REPO, "tools/devkit/runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-ui-states`));
  mkdirSync(out, { recursive: true });
  const report = {
    schema: "archer-ui-states/1",
    generatedAt: new Date().toISOString(),
    criteria: ["V5", "H4", "G9", "G11"],
    out,
    states: [],
    limitations: [
      "One desktop light-state sample per fixture, not the full rubric matrix. G9 captures live-region structure; screen-reader speech still requires manual verification.",
      "A supplied prebuilt page may differ from the dev server source. Both paths are recorded.",
    ],
    cleanup: null,
  };
  let kit,
    browser = suppliedBrowser;
  const ownsBrowser = !suppliedBrowser;
  try {
    browser ??= await chromium.launch({ headless: true });
    if (devUrl) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 900 } });
      try {
        const p = await ctx.newPage();
        const response = await p.goto(devUrl);
        await p.locator("body").waitFor();
        report.devBaseline = {
          url: p.url(),
          login: devUrl,
          status: response?.status(),
          text: (await p.locator("body").innerText()).slice(0, 3000),
        };
        await p.screenshot({ path: join(out, "dev-baseline.png") });
      } finally {
        await ctx.close();
      }
    }
    kit = await createStateFixtures({ page, name });
    report.sandbox = { name: kit.sandbox.name, origin: kit.sandbox.origin, page: kit.sandbox.page };
    for (const state of STATE_NAMES) {
      const fixture = await kit.setup(state),
        ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, colorScheme: "light" });
      try {
        const p = await ctx.newPage();
        p.setDefaultTimeout(10000);
        const response = await p.goto(fixture.login);
        if (fixture.url !== fixture.login) await p.goto(fixture.url);
        await p
          .locator("main")
          .first()
          .waitFor({ timeout: 15000 })
          .catch(() => {});
        if (state === "service-stopped") {
          await p.locator(".react-flow, .archer-seq-canvas, .archer-figure-canvas").first().waitFor({ timeout: 15000 });
          await fixture.stop();
        }
        let settleError;
        try {
          await expect
            .poll(async () => (await inspectState(p, fixture)).ok, { timeout: 15000, message: `${state} outcome` })
            .toBe(true);
        } catch (error) {
          settleError = String(error.message).slice(0, 1200);
        }
        const measurement = await measureState(p, fixture, { out });
        measurement.httpStatus = response?.status();
        if (settleError) measurement.settleError = settleError;
        report.states.push(measurement);
      } catch (error) {
        report.states.push({
          ...Object.fromEntries(Object.entries(fixture).filter(([, v]) => typeof v !== "function")),
          observed: { ok: false, failures: [String(error.message)] },
        });
      } finally {
        await ctx.close();
      }
    }
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    if (ownsBrowser) await browser?.close();
    if (kit) {
      try {
        await kit.close();
        report.cleanup = { sandboxStopped: true };
      } catch (error) {
        report.cleanup = { sandboxStopped: false, error: String(error) };
      }
    }
  }
  report.counts = {
    fixtures: report.states.length,
    passed: report.states.filter((s) => s.observed.ok).length,
    failed: report.states.filter((s) => !s.observed.ok).length,
    timeExpiryUnsupported: 1,
  };
  report.ok = !report.error && report.counts.failed === 0 && report.counts.fixtures === STATE_NAMES.length;
  writeFileSync(join(out, "ui-states.json"), JSON.stringify(report, null, 2) + "\n");
  const rows = report.states.map(
    (s) => `| ${s.name} | ${s.role} | ${s.mode} | ${s.observed.ok ? "PASS" : "FAIL"} | ${s.observed.url ?? s.url} |`,
  );
  writeFileSync(
    join(out, "ui-states.md"),
    `# UI state fixtures\n\n${report.counts.passed}/${report.counts.fixtures} observed states passed. Actual time-expired links unsupported; revoked-link fallback is explicitly labelled.\n\n| State | Role | Mode | Outcome | Exact URL |\n|---|---|---|---|---|\n${rows.join("\n")}\n\n${report.limitations.join("\n\n")}\n\nPrivate sandbox cleanup: ${JSON.stringify(report.cleanup)}.\n${report.error ?? ""}\n`,
  );
  return report;
}

/** A smoke journey runs private fixtures while preserving the harness browser and service. */
export async function runUiStates({ page, step, run }, options = {}) {
  let report;
  const measure = async () => {
    report = await runStateFixtures({
      ...options,
      out: options.out ?? join(run.dir, "ui-states"),
      browser: page.context().browser(),
    });
    if (!report.ok)
      throw new Error(
        `UI state fixtures failed: ${report.counts.failed}/${report.counts.fixtures} observed states failed${report.error ? "; " + report.error.split("\n")[0] : ""}`,
      );
  };
  if (step) await step("UI state fixtures", measure);
  else await measure();
  return report;
}
export const meta = { name: "ui-states", maxMs: 180000 };
export default runUiStates;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      page: { type: "string" },
      name: { type: "string" },
      "dev-url": { type: "string" },
    },
  });
  const report = await runStateFixtures({
    out: values.out,
    page: values.page,
    name: values.name,
    devUrl: values["dev-url"],
  });
  console.log(JSON.stringify({ ok: report.ok, counts: report.counts, out: report.out, error: report.error }));
  if (!report.ok) process.exitCode = 1;
}
