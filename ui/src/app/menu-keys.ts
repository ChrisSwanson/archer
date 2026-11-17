/** A menu's keys: ↑/↓ (wrapping), Home and End move among `items`; Esc closes and refocuses its button; Tab closes and lets focus go on. */
export function menuKeys(
  event: { readonly key: string; preventDefault(): void; stopPropagation(): void },
  items: readonly HTMLElement[],
  close: (refocus: boolean) => void,
): void {
  const at = items.indexOf(document.activeElement as HTMLElement);
  const move = (to: number): void => {
    event.preventDefault();
    items[(to + items.length) % items.length]?.focus();
  };
  if (event.key === "ArrowDown") move(at + 1);
  else if (event.key === "ArrowUp") move(at - 1);
  else if (event.key === "Home") move(0);
  else if (event.key === "End") move(items.length - 1);
  else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "Tab") close(false);
}
