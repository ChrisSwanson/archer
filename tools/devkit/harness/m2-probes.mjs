// M2 recipes verify the action's effect before judging focus. A successful key press/click alone is no evidence
// that its task happened. Missing fixtures and a refused action are measured separately from a wrong destination.
import { focusStop, settleFocus } from "./focus-walk.mjs";
const present = async (loc) => (await loc.count()) > 0 && (await loc.first().isVisible());
const activate = async (page, loc, key = "Enter") => {
  await loc.focus();
  await page.keyboard.press(key);
  await settleFocus(page);
};
export const matches = async (loc, predicate) =>
  (await loc.count()) > 0 && (await loc.evaluate(predicate, undefined, { timeout: 1000 }).catch(() => false));
const attempted = (reason, evidence = {}) => ({ executed: false, reason, evidence });
const wait = async (page, predicate, arg, timeout) => {
  try {
    await page.waitForFunction(predicate, arg, { timeout });
    return true;
  } catch {
    return false;
  }
};

/** Outcome is evidence about execution/coverage, not an inferred WCAG verdict. Keep the focus observations. */
export async function collectCheckpoint(page, probe) {
  const observations = [];
  try {
    const result = await probe(page, async (at) => observations.push({ at, ...(await page.evaluate(focusStop)) }));
    const outcome = result?.skip
      ? "coverage absent"
      : result?.executed === false
        ? "action not executed"
        : result?.destinationCorrect === false
          ? "destination wrong"
          : result?.destinationCorrect === true
            ? "destination correct"
            : "observed";
    return {
      status: outcome === "coverage absent" ? "skipped" : "observed",
      outcome,
      ...result,
      reason: result?.skip ?? result?.reason,
      observations,
    };
  } catch (error) {
    return {
      status: "error",
      outcome: "action not executed",
      executed: false,
      reason: String(error.message).split("\n")[0],
      observations,
    };
  }
}

export async function columnCheckbox(page, rec = async () => {}) {
  // Scope by the section's identity, never a checkbox's position in the whole dialog (Notes is a kind filter).
  const d = page.getByRole("dialog").first();
  const section = d.locator(
    '[data-section="table-columns"], [role="group"][aria-label="Table Columns"], section:has(> h3:text-is("Table Columns")), fieldset:has(> legend:text-is("Table Columns"))',
  );
  const cb = section.getByRole("checkbox").filter({ visible: true }).first();
  if (!(await present(cb)))
    return { skip: "no column checkbox in Table Columns; file-kind filters are not column controls" };
  const before = await cb.isChecked();
  await activate(page, cb, "Space");
  const after = await cb.isChecked();
  await rec("after Space");
  const retained = await matches(cb, (e) => e === document.activeElement);
  // Restore through the same real control even if the page moved focus elsewhere.
  await activate(page, cb, "Space");
  await rec("after Space again (restored)");
  if (before === after || (await cb.isChecked()) !== before)
    return attempted("column checkbox did not toggle and restore", { before, after });
  return {
    executed: true,
    destinationCorrect: retained && (await matches(cb, (e) => e === document.activeElement)),
    evidence: { before, after },
  };
}

export async function highlights(page, rec = async () => {}, { off = false } = {}) {
  const h = page.getByRole("button", { name: /^Highlights/ }).first();
  if (!(await present(h))) return { skip: "no Highlights control (emphasis fixture absent)" };
  // A saved/agent emphasis may start active. Establish the list's off→on precondition before recording F22.
  if ((await h.getAttribute("aria-pressed")) === "true") await activate(page, h);
  if ((await h.getAttribute("aria-pressed")) !== "false") return attempted("could not establish Highlights off");
  await activate(page, h);
  await rec("F22: after activate");
  if ((await h.getAttribute("aria-pressed")) !== "true") return attempted("Highlights activation did not turn it on");
  let destinationCorrect = await matches(h, (e) => e === document.activeElement);
  if (off) {
    await activate(page, h);
    await rec("F23: after second activate");
    if ((await h.getAttribute("aria-pressed")) !== "false")
      return attempted("second activation did not turn Highlights off");
    destinationCorrect &&=
      (await matches(h, (e) => e === document.activeElement)) &&
      (await page.getByText("Explore", { exact: true }).first().isVisible());
  }
  return { executed: true, destinationCorrect, evidence: { pressed: await h.getAttribute("aria-pressed") } };
}

export async function deleteShape(page, rec = async () => {}, { timeout = 3000 } = {}) {
  const part = page.locator(".authoring-parts").getByRole("button", { name: "Process", exact: true });
  if (!(await present(part))) return { skip: "no Process part for an unconnected deletion fixture" };
  const nodes = page.locator(".authoring-workspace .react-flow__node");
  const initial = await nodes.count();
  const initialIds = await nodes.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-id")));
  await part.click();
  const field = page.locator(".archer-node-label-input");
  try {
    await field.waitFor({ state: "visible", timeout });
  } catch {
    return attempted("Process did not open its label field");
  }
  const label = "M2 unconnected delete probe";
  await field.fill(label);
  await page.keyboard.press("Enter");
  if (
    !(await wait(
      page,
      (count) => document.querySelectorAll(".authoring-workspace .react-flow__node").length === count,
      initial + 1,
      timeout,
    ))
  )
    return attempted("Process node was not added");
  // SVG line wrapping can join adjacent tspans without a space; labels are not stable locator identities.
  const addedIds = await nodes.evaluateAll(
    (elements, known) =>
      elements.map((element) => element.getAttribute("data-id")).filter((id) => id !== null && !known.includes(id)),
    initialIds,
  );
  if (addedIds.length !== 1) return attempted("could not identify the one added node by its stable data-id");
  const shape = page.locator(`.authoring-workspace .react-flow__node[data-id=${JSON.stringify(addedIds[0])}]`);
  await shape.focus();
  await page.keyboard.press("Space");
  await settleFocus(page);
  if (
    (await shape.getAttribute("aria-pressed")) !== "true" &&
    (await shape.getAttribute("aria-selected")) !== "true" &&
    !(await matches(shape, (e) => e.classList.contains("selected")))
  )
    return attempted("new unconnected node was not selected");
  const before = await nodes.count();
  await page.keyboard.press("Delete");
  const deleted = await wait(
    page,
    (count) => document.querySelectorAll(".authoring-workspace .react-flow__node").length === count,
    before - 1,
    timeout,
  );
  await settleFocus(page);
  await rec("after Delete (count verified)");
  const evidence = { before, after: await nodes.count() };
  if (!deleted) return attempted("Delete was refused or did not remove the unconnected node", evidence);
  return {
    executed: true,
    destinationCorrect: await page.evaluate(
      () =>
        !!document.activeElement?.closest(
          '.authoring-workspace .react-flow__node, .authoring-preview, [role="group"][aria-label="Diagram drawing"]',
        ),
    ),
    evidence,
  };
}

export async function commentPin(page, rec = async () => {}, { timeout = 3000 } = {}) {
  const pin = page.locator("[data-pin-thread]").filter({ visible: true }).first();
  if (!(await present(pin))) return { skip: "no comment pin fixture" };
  // Pin spans/SVG groups need pointer activation. focus()+Enter can report a fictitious transition.
  const thread = await pin.getAttribute("data-pin-thread");
  await pin.click();
  const opened = await wait(
    page,
    () =>
      [
        ...document.querySelectorAll(
          '.primary-floating-discussion, [role="region"][aria-label="Contextual discussion"]',
        ),
      ].some((e) => e.getClientRects().length > 0),
    undefined,
    timeout,
  );
  await settleFocus(page);
  await rec("after real pin click");
  if (!opened) return attempted("pin click did not open its discussion", { thread });
  let destinationCorrect = await page.evaluate(
    () =>
      !!document.activeElement?.closest(
        '.primary-floating-discussion, [role="region"][aria-label="Contextual discussion"]',
      ),
  );
  await page.keyboard.press("Escape");
  await settleFocus(page);
  await rec("after Escape");
  const returned = await matches(pin, (e) => e === document.activeElement);
  destinationCorrect &&= returned;
  return { executed: true, destinationCorrect, evidence: { thread, opened, returnedToPin: returned } };
}

export async function dirtySettings(page, rec = async () => {}, { timeout = 3000 } = {}) {
  const d = page.getByRole("dialog", { name: /Project Settings/ }).first();
  // This is editable in every project; Name/Description are readonly and cannot create dirty state.
  const radios = d.getByRole("radio").filter({ visible: true });
  const always = d.getByRole("radio", { name: "Always show", exact: true });
  let radio = always;
  if ((await present(always)) && (await always.isChecked())) {
    for (const candidate of await radios.all())
      if (!(await candidate.isChecked())) {
        radio = candidate;
        break;
      }
  }
  if (!(await present(radio))) return { skip: "no editable project visibility radio" };
  const before = await radio.isChecked();
  if (before || (await radio.isDisabled())) return attempted("no unchecked editable visibility option");
  await radio.check();
  if (!(await radio.isChecked())) return attempted("visibility setting did not change");
  await page.keyboard.press("Escape");
  const keep = page.getByRole("button", { name: "Keep editing", exact: true }).first();
  // Project settings confirms in its existing dialog footer rather than opening a second alertdialog.
  let confirmationOpened = true;
  try {
    await keep.waitFor({ state: "visible", timeout });
  } catch {
    confirmationOpened = false;
  }
  await settleFocus(page);
  await rec("after Escape with verified change");
  // The edit did execute even if Escape silently discards it: that is a destination/guard defect.
  if (!confirmationOpened)
    return {
      executed: true,
      destinationCorrect: false,
      reason: "dirty Escape did not open the confirmation",
      evidence: { confirmationOpened },
    };
  const correctOpen = await matches(keep, (e) => e === document.activeElement);
  await activate(page, keep);
  await rec("after Keep editing");
  const close = d.getByRole("button", { name: "Close settings", exact: true });
  return {
    executed: true,
    destinationCorrect: correctOpen && (await matches(close, (e) => e === document.activeElement)),
    evidence: {
      confirmationOpened,
      changedRadio: await radio.evaluate((e) => e.labels?.[0]?.textContent?.trim() ?? e.getAttribute("aria-label")),
    },
  };
}

/** The corpus carries a passage thread on the hosted-payment note. Escape collapses it (a second click expands the quote). */
export async function noteDiscussion(page, rec = async () => {}) {
  const bubble = page.locator(".primary-note-discussion-bubble").filter({ visible: true }).first();
  if (!(await present(bubble))) return { skip: "no passage discussion bubble on the selected note" };
  await activate(page, bubble);
  await rec("after margin bubble");
  if ((await bubble.getAttribute("aria-expanded")) !== "true") return attempted("margin discussion did not expand");
  let destinationCorrect = await matches(
    bubble,
    (e) => e === document.activeElement || !!e.closest(".primary-note-discussion")?.contains(document.activeElement),
  );
  await page.keyboard.press("Escape");
  await settleFocus(page);
  await rec("after collapsing with Escape");
  if ((await bubble.getAttribute("aria-expanded")) !== "false")
    return attempted("Escape did not collapse the note discussion");
  destinationCorrect &&= await matches(bubble, (e) => e === document.activeElement);
  return { executed: true, destinationCorrect };
}

const walkLauncher = (page) => page.getByRole("button", { name: /^Walkthroughs\s*·/ }).first();
const currentStep = (page) => page.getByRole("list", { name: /^Steps of / }).locator('button[aria-current="step"]');

/** Open the corpus tour. F25 permits either a chooser or the current step when there is one tour. */
export async function openWalkthrough(page, rec = async () => {}, { choose = false, timeout = 3000 } = {}) {
  const launcher = walkLauncher(page);
  if (!(await present(launcher))) return { skip: "no walkthrough launcher on the selected corpus diagram" };
  await activate(page, launcher);
  const opened = await wait(
    page,
    () =>
      [...document.querySelectorAll('.archer-walk, [role="group"][aria-label="Walkthroughs on this diagram"]')].some(
        (e) => e.getClientRects().length,
      ),
    undefined,
    timeout,
  );
  if (!opened) return attempted("Walkthroughs did not open a panel or chooser");
  if (choose) {
    let choices = page.getByRole("group", { name: "Walkthroughs on this diagram", exact: true });
    if (!(await present(choices))) {
      const picker = page.locator(".archer-walk-pick").first();
      if (!(await present(picker))) return { skip: "no walkthrough chooser or picker in the panel" };
      await activate(page, picker);
      choices = page.getByRole("group", { name: "Walkthroughs on this diagram", exact: true });
    }
    const choice = choices.getByRole("button").first();
    if (!(await present(choice))) return attempted("walkthrough picker did not expose a choice");
    await activate(page, choice);
    await rec("after choosing a walkthrough");
    const row = currentStep(page);
    if (!(await present(row))) return attempted("choosing the tour did not show its current step");
    return { executed: true, destinationCorrect: await matches(row, (e) => e === document.activeElement) };
  }
  await rec("after Walkthroughs");
  const choices = page
    .getByRole("group", { name: "Walkthroughs on this diagram", exact: true })
    .getByRole("button")
    .first();
  const row = currentStep(page);
  return {
    executed: true,
    destinationCorrect:
      (await matches(row, (e) => e === document.activeElement)) ||
      (await matches(choices, (e) => e === document.activeElement)),
  };
}

/** A chosen tour is required for the transport, tabs, camera follow and exit checkpoints. */
export async function walkthroughAction(page, rec = async () => {}, { id, timeout = 3000 } = {}) {
  const opened = await openWalkthrough(page);
  if (!opened.executed) return opened;
  if (!(await present(currentStep(page)))) {
    const choice = page
      .getByRole("group", { name: "Walkthroughs on this diagram", exact: true })
      .getByRole("button")
      .first();
    if (!(await present(choice))) return attempted("no tour could be chosen");
    await activate(page, choice);
  }
  if (id === "F27") {
    const controls = page.getByRole("group", { name: "Step controls", exact: true });
    const next = controls.getByRole("button", { name: "Next step", exact: true });
    const scrub = controls.getByRole("slider", { name: "Step", exact: true });
    if (!(await present(next)) || !(await present(scrub)))
      return { skip: "no step transport on the selected walkthrough" };
    const total = Number(await scrub.getAttribute("max"));
    if (!(total >= 2 && total <= 256))
      return { skip: "walkthrough needs between 2 and 256 steps for the end-of-transport check" };
    let destinationCorrect = true;
    for (let step = 2; step <= total; step++) {
      await activate(page, next);
      if (
        !(await wait(
          page,
          (n) => Number(document.querySelector('input[aria-label="Step"]')?.value) === n,
          step,
          timeout,
        ))
      )
        return attempted("Next did not advance to the expected step", { expectedStep: step });
      await rec(`Next: step ${step} of ${total}`);
      destinationCorrect &&= await matches(next, (e) => e === document.activeElement);
      const spoken = await page.locator('[aria-live="polite"]').allTextContents();
      destinationCorrect &&= spoken.some((text) => text.includes(`Step ${step} of ${total}:`));
    }
    await activate(page, next);
    await rec("Next at the last step");
    destinationCorrect &&= await matches(
      next,
      (e) => e === document.activeElement && !e.disabled && e.getAttribute("aria-disabled") === "true",
    );
    return { executed: true, destinationCorrect, evidence: { total, finalStep: Number(await scrub.inputValue()) } };
  }
  if (id === "F28") {
    const tabs = page.getByRole("tablist", { name: "Panel view", exact: true });
    if (!(await present(tabs))) return { skip: "walkthrough has no Steps/Sequence tabs (message fixture absent)" };
    const initial = tabs.getByRole("tab", { selected: true });
    const before = await initial.textContent();
    await initial.focus();
    await page.keyboard.press("ArrowRight");
    await settleFocus(page);
    await rec("after ArrowRight on Panel view");
    const selected = tabs.getByRole("tab", { selected: true });
    if ((await selected.textContent()) === before) return attempted("ArrowRight did not switch Panel view tabs");
    let destinationCorrect = await matches(selected, (e) => e === document.activeElement);
    await page.keyboard.press("ArrowLeft");
    await settleFocus(page);
    await rec("after ArrowLeft on Panel view");
    destinationCorrect &&= await matches(
      tabs.getByRole("tab", { selected: true }),
      (e) => e === document.activeElement,
    );
    return { executed: true, destinationCorrect };
  }
  if (id === "F29") {
    const follow = page.getByRole("button", { name: "Follow steps", exact: true });
    if (!(await present(follow))) return { skip: "no Follow steps control" };
    const before = await follow.getAttribute("aria-pressed");
    await activate(page, follow);
    await rec("after Follow steps");
    if ((await follow.getAttribute("aria-pressed")) === before) return attempted("Follow steps did not toggle");
    return { executed: true, destinationCorrect: await matches(follow, (e) => e === document.activeElement) };
  }
  if (id === "F30") {
    const close = page.getByRole("button", { name: "Close walkthrough", exact: true });
    if (!(await present(close))) return { skip: "no Close walkthrough control" };
    await activate(page, close);
    await rec("after Close walkthrough");
    const launcher = walkLauncher(page);
    if ((await launcher.getAttribute("aria-pressed")) !== "false")
      return attempted("Close walkthrough did not leave walkthrough mode");
    return { executed: true, destinationCorrect: await matches(launcher, (e) => e === document.activeElement) };
  }
  return { skip: `no walkthrough recipe for ${id}` };
}

export async function markNotificationRead(page, rec = async () => {}, { timeout = 3000 } = {}) {
  const bell = page.getByRole("button", { name: /Notifications/ }).first();
  if (!(await present(bell))) return { skip: "no Notifications launcher" };
  await activate(page, bell);
  const dialog = page.getByRole("dialog", { name: "Notifications", exact: true });
  const marks = dialog.getByRole("button", { name: "Mark read", exact: true });
  try {
    await marks.first().waitFor({ state: "visible", timeout });
  } catch {
    return { skip: "no unread Notifications item in this fresh browser context" };
  }
  const before = await marks.count();
  await activate(page, marks.first());
  const removed = await wait(
    page,
    (count) =>
      [...document.querySelectorAll('[role="dialog"][aria-label="Notifications"] button')].filter(
        (e) => e.textContent.trim() === "Mark read",
      ).length === count,
    before - 1,
    timeout,
  );
  await settleFocus(page);
  await rec("after Mark read");
  const after = await marks.count();
  if (!removed) return attempted("Mark read did not consume the unread item", { before, after });
  const destinationCorrect =
    after > 0
      ? await matches(marks.first(), (e) => e === document.activeElement)
      : await matches(dialog, (e) => e === document.activeElement);
  return { executed: true, destinationCorrect, evidence: { before, after } };
}

export async function highlightMember(page, rec = async () => {}) {
  const on = await highlights(page);
  if (!on.executed) return on;
  const toggle = page.getByRole("button", { name: "Members", exact: true });
  if (!(await present(toggle))) return { skip: "no Members disclosure in the active highlight legend" };
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await activate(page, toggle);
  const member = page.locator(".archer-emph-members button").filter({ visible: true }).first();
  if (!(await present(member))) return { skip: "no member buttons in the expanded Members list" };
  const label = (await member.textContent()).trim();
  await activate(page, member);
  await rec("after activating the first named member");
  const focus = await page.evaluate(focusStop);
  const destinationCorrect = await page.evaluate((expected) => {
    const active = document.activeElement;
    if (!active?.closest(".react-flow, .react-flow__node, .archer-seq-viewport, .archer-journey")) return false;
    const name = (active.getAttribute("aria-label") ?? active.textContent ?? "").replace(/\s+/g, " ").trim();
    return name.includes(expected);
  }, label);
  return {
    executed: true,
    destinationCorrect: destinationCorrect && !focus.obscured?.hidden,
    evidence: { member: label },
  };
}
