/** On the landing, the nav sits on the stage's colour until the reader scrolls past it (R3-2: 640px). */
export const NAV_STAGE_CLASS = "landing-on-stage";
const STAGE_PX = 640;

/** Follows the scroll while the landing is open; the returned function hands the nav back to every other page. */
export function navOnStage(win: Window): () => void {
  const root = win.document.documentElement;
  const update = () => root.classList.toggle(NAV_STAGE_CLASS, (win.scrollY || 0) <= STAGE_PX);
  update();
  win.addEventListener("scroll", update, { passive: true });
  return () => {
    win.removeEventListener("scroll", update);
    root.classList.remove(NAV_STAGE_CLASS);
  };
}
