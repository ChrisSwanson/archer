import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { PlaygroundBoot } from "./boot";
import { PlaygroundScene } from "./scene";

/** The landing's compact scene: the shared stage, player and review controls, without the App. */
export function mount(element: HTMLElement, boot: PlaygroundBoot): void {
  createRoot(element).render(
    <StrictMode>
      <PlaygroundScene snapshot={boot.snapshot} runtime={boot.runtime} />
    </StrictMode>,
  );
}
