// Shared start for the user-flows journeys (rubric docs/quality/rubrics/user-flows.md §6). Each journey file is a
// plain harness journey (smoke.mjs runs it), with `meta.flow = { id, baseline: [{ action, class }], matrix }`;
// flows/run.mjs runs it per matrix cell and N times.
//
//   const { flow, rt, cell, O } = await begin(ctx, meta);
//
// begin(): resets pageturner (ui.resetProject: files, saved layouts, this browser's drafts), starts the action
// trace (flow-metrics.mjs) and the U7 round-trip table (round-trip.mjs), and names the cell (viewport,
// comment_submission) this run is in. A cell comes from flows/run.mjs (ctx.cell), else FLOW_CELL (JSON), else the
// journey's first cell.
import { flowRecorder } from "../../harness/flow-metrics.mjs";
import { roundTrip } from "../../harness/round-trip.mjs";

export const PROJECT = "pageturner";
export const CHECKOUT = "diagrams/checkout.mmd";
/** The corpus walkthrough J4 and J10 use. The rubric names `checkout`, a sequence diagram, which cannot host one (list_walkthroughs: "walkthroughs are on graph diagrams"; ADR 0034 open question 5). */
export const WALK = {
  path: "diagrams/fulfilment.mmd",
  viewId: "fulfilment",
  id: "order-to-courier",
  title: "From Order to Courier",
  steps: 4,
  h1: "Order Fulfilment",
};
export const NOTE_0001 = "notes/0001-hosted-payment-page.md";

export function cellOf(ctx, meta) {
  if (ctx.cell) return ctx.cell;
  if (process.env.FLOW_CELL) return JSON.parse(process.env.FLOW_CELL);
  return { viewport: meta.viewport ?? { width: 1440, height: 900 }, commentSubmission: "immediate" };
}

export async function begin(ctx, meta, { reset = true } = {}) {
  const cell = cellOf(ctx, meta);
  if (reset && !ctx.resetDone) for (const slug of meta.flow.projects ?? [PROJECT]) await ctx.ui.resetProject(slug);
  const flow = seeded(flowRecorder(ctx, { ...meta.flow, cell }), ctx);
  const rt = roundTrip({ ui: ctx.ui, step: ctx.step, run: ctx.run, page: ctx.page });
  return { flow, rt, cell, O: ctx.sandbox.origin.replace(/\/$/, "") };
}

/**
 * A seeded fault for proving the collectors (demo/prove-collectors.mjs): `ctx.seed.extraOverhead = { after }` adds
 * one overhead action (a scroll of the page that reveals nothing the goal needs) right after the named action.
 * Journeys never set it; without a seed the recorder is returned as it is.
 */
function seeded(flow, ctx) {
  const extra = ctx.seed?.extraOverhead;
  if (!extra) return flow;
  const act = flow.act.bind(flow);
  return Object.assign(Object.create(flow), {
    act: async (action, cls, fn, opts) => {
      const value = await act(action, cls, fn, opts);
      if (action === extra.after)
        await act("seeded: scroll the page", "overhead", () => ctx.page.mouse.wheel(0, 120), { kind: "scroll" });
      return value;
    },
    goal: flow.goal.bind(flow),
    note: flow.note.bind(flow),
  });
}

/** A path inside the project's address space. */
export const at = (O, path = "") => `${O}/projects/${PROJECT}/${path}`;

/**
 * `ctx.ui` whose fresh contexts sign in with a link of their own, issued once per run (sandbox.mjs issueLink, an
 * editing link like the sandbox's). The service takes at most 20 sign-ins a minute per link
 * (MAX_SESSION_MINTS_PER_MINUTE, ts/src/service/access-grants.ts) and answers more with 404, so round trips (one
 * fresh context per URL) on the sandbox's one link run out of sign-ins once a few runs go back to back.
 */
export async function ownLinkUi(ctx) {
  const { issueLink } = await import("../../sandbox.mjs");
  const link = issueLink({ name: ctx.sandbox.name, label: `flows ${ctx.run?.name ?? "journey"}` }).url;
  return Object.assign(Object.create(ctx.ui), {
    openContext: (opts = {}) => ctx.ui.openContext(opts.fresh && !opts.link && !opts.reader ? { ...opts, link } : opts),
  });
}
