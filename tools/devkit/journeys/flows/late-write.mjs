// Late delete/resolve/dismiss (codex-501), a collector journey for flows-prove.mjs (not a matrix journey: no meta.flow).
// A comment is resolved on Checkout; the browser's request is held and failed, and the very same request is delivered
// to Archer 18 s later, after the page's last read-back (2, 6 and 15 s). Collector G4: after the last check the page
// keeps the outcome not known (what it last saw, with its time), never a definite "did not" from a read made before
// the request could arrive; once delivered, the next listing (the change's own event) settles it: the message goes and
// the thread is resolved. Seeded fault `definite-late-refusal` (the page's final words as before codex-501: "… so it
// did not resolve the thread. Try again.") fails it.
import { assertFlowChecks } from "../../harness/flows-state.mjs";
import { composeComment, addComment, within } from "./state-lib.mjs";

export const meta = {
  name: "flows-late-write",
  invariants: { "console-errors": false, "failed-requests": false, "duplicate-requests": false },
};
const DELAY_MS = 18_000;

export default async ({ page, ui, step, expect, context, run }) => {
  await ui.resetProject("pageturner");
  await ui.openDiagram("pageturner", "diagrams/checkout.mmd");
  const text = `Late resolve ${Date.now()}`;
  await composeComment({ page, step, expect }, text);
  await addComment({ page, step });
  const [thread] = await within(
    page,
    async () => {
      const t = await ui.threadsWith("pageturner", "view:checkout", text);
      return t.length ? t : null;
    },
    { timeout: 10_000 },
  );
  const region = page.getByRole("region", { name: "Contextual discussion", exact: true });
  let held = false,
    delivery = null,
    delivered = null;
  const hold = async (route) => {
    const r = route.request();
    if (held || r.method() !== "POST" || !r.url().includes(`${thread.id}/resolve`)) return route.fallback();
    held = true;
    const headers = await r.allHeaders(),
      url = r.url(),
      data = r.postData();
    delivery = new Promise((done) =>
      setTimeout(async () => {
        try {
          const answer = await context.request.fetch(url, { method: "POST", headers, ...(data ? { data } : {}) });
          delivered = { status: answer.status() };
        } catch (e) {
          delivered = { error: String(e).split("\n")[0] };
        }
        done();
      }, DELAY_MS),
    );
    return route.abort("failed");
  };
  await page.route("**/api/comments/**", hold);
  const started = Date.now();
  await step("click Resolve (its request is held, then failed)", async () => {
    await region.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(page.getByText(/not known yet whether/).first()).toBeVisible();
  });
  // After the last check (15 s), before delivery (18 s): what the page says now.
  await step("wait past the last read-back", () => page.waitForTimeout(Math.max(0, 16_500 - (Date.now() - started))));
  const body = async () =>
    (
      (await page
        .locator("body")
        .innerText()
        .catch(() => "")) ?? ""
    ).replace(/\s+/g, " ");
  const afterChecks = await body();
  const definite = /so it did not resolve/i.test(afterChecks);
  const unknown =
    /not known whether it did resolve the thread: when last checked, at [^,]+, the thread is still there/.test(
      afterChecks,
    );
  ui.flowCheck(
    "G4",
    "late resolve, after the last check: not known, what was last seen and when, never a definite did not",
    unknown && !definite,
    { unknown, definite, said: (afterChecks.match(/Archer did not answer[^.]*\.[^.]*\./) ?? [null])[0] },
  );
  await step("the held request reaches Archer (18 s)", async () => {
    await delivery;
  });
  const settled = await within(page, async () => !/Archer did not answer/.test(await body()), { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  const now = (await ui.threads("pageturner", "view:checkout").catch(() => [])).some((t) => t.id === thread.id);
  const finalText = await body();
  ui.flowCheck(
    "G4",
    "late resolve, delivered after the last check: the next listing settles it, the message goes, and the thread is resolved",
    settled && delivered?.status === 200 && !now && !/so it did not resolve/i.test(finalText),
    {
      settled,
      delivered,
      stillListed: now,
      said: (finalText.match(/Archer did not answer[^.]*\.[^.]*\./) ?? [null])[0],
    },
  );
  await page.unroute("**/api/comments/**", hold).catch(() => {});
  await assertFlowChecks({ step, run });
};
