import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { PlaygroundBoot } from "./boot";
import { PlaygroundShell } from "./shell";

// The App defers its walkthrough modules; the example loads them with its view (they are small), so once the
// page has drawn, reading, commenting and playback need nothing more from the asset server.
const deferred = Promise.all([import("../walkthroughs/WalkthroughSlot"), import("../walkthroughs/OldVersionStage")]);

export async function mount(element: HTMLElement, boot: PlaygroundBoot): Promise<void> {
  await deferred.catch(() => undefined);
  createRoot(element).render(
    <StrictMode>
      <PlaygroundShell index={boot.index} snapshot={boot.snapshot} runtime={boot.runtime} />
    </StrictMode>,
  );
}
