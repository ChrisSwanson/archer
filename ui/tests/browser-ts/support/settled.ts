/**
 * The drawing at rest, as the page says it: every graph canvas laid out and framed (`data-framed="true"`), its camera
 * still (`data-camera="idle"`, set by the canvas from React Flow's move start and end, programmatic glides included)
 * and no frame opening or closing (`archer-nest-moving`). Then two animation frames, so what was settled is painted.
 *
 * A wait on the app rather than on a clock: it holds as long as a slow host needs and no longer. It says nothing of a
 * motion that has not started yet, so wait for what the action shows first (a node, a pressed button), then for this.
 * A page with no graph canvas (a sequence, a note) is settled at once; so is a drawing rendered without the canvas
 * (no `data-camera`: a figure in a note, a preview).
 */
import type { Frame, Page } from "@playwright/test";

export async function settled(page: Page | Frame, options: { timeout?: number } = {}): Promise<void> {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".react-flow[data-camera]")].every(
        (flow) =>
          flow.getAttribute("data-framed") === "true" &&
          flow.getAttribute("data-camera") === "idle" &&
          !flow.classList.contains("archer-nest-moving"),
      ),
    undefined,
    options.timeout === undefined ? {} : { timeout: options.timeout },
  );
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}
