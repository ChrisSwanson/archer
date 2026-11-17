import { flushSync } from "react-dom";
import { fireEvent, screen, within } from "@testing-library/react";

const NAME = "Project documents";

/**
 * The project page's gallery of files (projects-and-search.md), opened from the
 * sidebar's Archer button when it is not already on screen. Opening it is a
 * navigation: the diagram on screen gives way to the project page.
 */
export function projectFiles(): HTMLElement {
  let files = screen.queryByRole("region", { name: NAME });
  if (files === null) {
    flushSync(() => fireEvent.click(screen.getByRole("button", { name: "Archer contents" })));
    files = screen.getByRole("region", { name: NAME });
  }
  return files;
}
/** A file's row button on the project page. */
export function fileButton(name: RegExp | string): HTMLElement {
  return within(projectFiles()).getByRole("button", { name });
}

/** The project page's gallery, once the inventory has arrived; the page goes there if it is elsewhere. */
export async function filesTable(): Promise<HTMLElement> {
  const shown = screen.queryByRole("region", { name: NAME });
  if (shown !== null) return shown;
  fireEvent.click(await screen.findByRole("button", { name: "Archer contents" }));
  return screen.findByRole("region", { name: NAME });
}
/** Opens a file from the project page, as a reader does. */
export async function openFile(name: RegExp | string): Promise<void> {
  fireEvent.click(await within(await filesTable()).findByRole("button", { name }));
}
/** A file's row button on the project page, once it is there. */
export async function fileRow(name: RegExp | string): Promise<HTMLElement> {
  return within(await filesTable()).findByRole("button", { name });
}
