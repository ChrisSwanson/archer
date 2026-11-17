/**
 * One TypeScript service per Playwright worker, a fresh project attached to it for each test.
 *
 * A service costs most of a second to start; an attach about 50 ms. A test that needs a project of its own, not a
 * service of its own, takes one here: the handle `startTsProject` returns, whose `stop` detaches the project and
 * removes its root. The service starts on first use with no project of its own attached, so the page lists only
 * the projects the running test attached.
 *
 * Not for a test that changes the service rather than its project: a restart, an offline seed (`beforeService`),
 * a clock (`now`), HTTPS, the shared config file (`configPath`), or access grants it lists. Those start their own
 * with `startTsProject`.
 *
 * A project a test leaves attached is detached before the next test attaches one, so a missed `stop` never shows
 * one test's project to another.
 *
 * The account remembers every root it ever attached, up to `MAX_REMEMBERED_PROJECTS` (256, `ts/src/state/account.ts`),
 * and no product call forgets one: a detach keeps it. So a service is renewed, its state directory removed and a fresh
 * one started, once it has taken `RENEW_AFTER` attaches and the test about to attach holds none of its projects. A
 * test is left `HEADROOM` attaches of its own; one that needs more starts its own service.
 */
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "@playwright/test";
import { startTsProject, type TsProject } from "../../support/ts-service";
import { testPage } from "./page-path";

export type SharedProjectOptions = {
  readonly files: Record<string, string>;
  /** Whether the project draws the nested view (ADR 0029); off unless its archer.toml says so. */
  readonly nestedView?: boolean;
  /**
   * Run on the project's root once its files are written, before it is attached: what a `beforeService` seed does
   * to the project (a `git init` and commit), never to the service's state.
   */
  readonly beforeAttach?: (root: string) => Promise<void> | void;
  /** The service's `comment_submission`: services differ by it, so each value has its own. */
  readonly commentSubmission?: "queued" | "immediate";
};

/** `MAX_REMEMBERED_PROJECTS` in `ts/src/state/account.ts`: the service's 257th distinct root is refused. */
const REMEMBERED = 256;
/** Attaches one test may make after the service was last renewed, its own first attach among them. */
const HEADROOM = 64;
const RENEW_AFTER = REMEMBERED - HEADROOM;

/** `attaches` counts every root the service's account remembers, its own first project's included. */
type Shared = { service: Promise<TsProject>; live: Map<TsProject, string>; attaches: number };
// On globalThis rather than in this module: a worker that evaluated this module again would start another.
const KEY = Symbol.for("archer.browser-ts.shared-service");
const registry = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<string, Shared>()) as Map<string, Shared>;

function shared(commentSubmission: SharedProjectOptions["commentSubmission"]): Shared {
  const key = commentSubmission ?? "";
  let entry = registry.get(key);
  if (entry === undefined) {
    const service = (async () => {
      const base = await startTsProject({
        pagePath: testPage(),
        files: { "archer.toml": "version = 1\n" },
        ...(commentSubmission === undefined ? {} : { commentSubmission }),
      });
      // The service's own first project is no test's: detached, its root removed.
      await base.call("detach");
      rmSync(base.root, { recursive: true, force: true });
      // The service ends with the worker; its state directory goes then too.
      const state = dirname(base.configPath);
      process.once("exit", () => rmSync(state, { recursive: true, force: true }));
      return base;
    })();
    entry = { service, live: new Map(), attaches: 1 };
    registry.set(key, entry);
    // A failed start is not kept: the next test tries again.
    service.catch(() => registry.delete(key));
  }
  return entry;
}

/** Stops the service, its state directory with it, and forgets it: the next `shared` starts another. */
async function renew(commentSubmission: SharedProjectOptions["commentSubmission"], entry: Shared): Promise<void> {
  registry.delete(commentSubmission ?? "");
  await (await entry.service).stop();
}

/** A fresh project on this worker's shared service. */
export async function sharedTsProject(options: SharedProjectOptions): Promise<TsProject> {
  let entry = shared(options.commentSubmission);
  await entry.service;
  const owner = test.info().testId;
  for (const [left, by] of entry.live)
    if (by !== owner) {
      entry.live.delete(left);
      await left.stop().catch(() => {});
    }
  if (entry.attaches >= RENEW_AFTER && entry.live.size === 0) {
    await renew(options.commentSubmission, entry);
    entry = shared(options.commentSubmission);
  }
  if (entry.attaches >= REMEMBERED)
    throw new Error(
      `one test attached more than ${HEADROOM} shared projects; the account remembers ${REMEMBERED}: start a service of its own`,
    );
  const service = await entry.service;
  entry.attaches++;
  const project = await service.attachProject(options.files, {
    ...(options.nestedView === undefined ? {} : { nestedView: options.nestedView }),
    ...(options.beforeAttach === undefined ? {} : { prepare: options.beforeAttach }),
  });
  entry.live.set(project, owner);
  return Object.assign(Object.create(project) as TsProject, {
    async stop() {
      entry.live.delete(project);
      await project.stop();
    },
  });
}
