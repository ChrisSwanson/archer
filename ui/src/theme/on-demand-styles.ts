/**
 * A stylesheet the page adds only when the part it styles first shows, not with the page's first load: a settings
 * dialog's rules do nothing until it opens, and every rule in the document is matched on every style recalculation
 * (performance rubric S2, unused CSS on first load). The sheet is imported as text (`./x.css?inline`, minified by
 * the build like the page's own), added once at the end of `<head>` and kept for the life of the document, so a
 * second opening paints at once. Only for a sheet whose selectors no other sheet overrides: it lands after them all.
 */
import { useInsertionEffect } from "react";

const added = new Set<string>();

/** Adds `css` as `<style data-archer-styles={id}>` before the first paint in which `when` holds; once per document. */
export function useOnDemandStyles(id: string, css: string, when: boolean): void {
  useInsertionEffect(() => {
    if (!when || added.has(id) || typeof document === "undefined") return;
    added.add(id);
    const style = document.createElement("style");
    style.dataset.archerStyles = id;
    style.textContent = css;
    document.head.append(style);
  }, [id, css, when]);
}

/** Tests only: a fresh document. */
export function resetOnDemandStylesForTests(): void {
  added.clear();
}
