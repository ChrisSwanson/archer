// The key recorder behind the shortcut-focus invariant (TG-a4). It runs in the page as an init script
// (`context.addInitScript(keyRecorder)`), so it must stay self-contained: no imports, no closure over this module.
//
// Each key is judged from its own events, never from a timer alone (O18). Chromium runs queued input ahead of
// timers: a `setTimeout(0)` after a keydown can run after the next keys (type, Backspace, Enter all queued) and
// then sees the field the last key closed. A key's record is final at the first of
//   - its keyup (focus at the end of the key press),
//   - the next keydown (the key cannot be judged on what a later key did),
//   - a `setTimeout(0)` (a key with no keyup yet, or the last key of a step).
// Whether the value took the key comes from `input` events on the key's target between its keydown and that
// point, or the value differing then; whether a handler took it from `defaultPrevented` (`beforeinput` included).
export function keyRecorder() {
  const describe = (el) =>
    el instanceof Element
      ? {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          cls: typeof el.className === "string" ? el.className.slice(0, 80) : undefined,
          label: el.getAttribute("aria-label") ?? undefined,
        }
      : null;
  const read = (t) => (t && "value" in t ? t.value : t?.isContentEditable ? t.textContent : null);
  let pending = null;
  const finish = () => {
    const p = pending;
    if (!p) return;
    pending = null;
    try {
      const after = read(p.t);
      window.__harnessReport?.({
        ...p.record,
        prevented: p.event.defaultPrevented || p.inputPrevented,
        focusMoved: document.activeElement !== p.t,
        focusAfter: describe(document.activeElement),
        valueChanged: p.inputTook || after !== p.value,
      });
    } catch {
      /* page closing */
    }
  };
  addEventListener(
    "keydown",
    (e) => {
      try {
        finish();
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
        const t = e.target instanceof Element ? e.target : null;
        const record = {
          kind: "key",
          key: e.key,
          ctrl: e.ctrlKey,
          meta: e.metaKey,
          alt: e.altKey,
          shift: e.shiftKey,
          target: describe(t),
          onBody: t === document.body || t === document.documentElement,
          inEditable: !!t?.closest("input, textarea, select, [contenteditable=''], [contenteditable=true]"),
          inDialog: !!t?.closest("dialog[open], [aria-modal='true'], [role=menu]"),
          editing: !!document.querySelector(".authoring-workspace"),
          busy:
            !!document.querySelector(".authoring-preview[aria-busy='true'], p.authoring-checking") ||
            /Working…/.test(document.querySelector(".authoring-statusline")?.textContent ?? ""),
          selection: document.querySelectorAll(
            ".react-flow__node.selected, .react-flow__edge.selected, .archer-seq-selected",
          ).length,
          // Alt+arrows move a sequence participant or message; graph canvases leave them to the browser (Alt+← is Back).
          sequence: !!document.querySelector(".archer-seq-canvas"),
        };
        const p = {
          record,
          event: e,
          t,
          code: e.code,
          key: e.key,
          value: read(t),
          inputTook: false,
          inputPrevented: false,
        };
        pending = p;
        setTimeout(() => {
          if (pending === p) finish();
        }, 0);
      } catch {
        /* never break the page */
      }
    },
    true,
  );
  // Bubble phase on window: the page's own handlers have run, so a cancelled beforeinput is known.
  addEventListener("beforeinput", (e) => {
    try {
      if (pending && e.target === pending.t && e.defaultPrevented) pending.inputPrevented = true;
    } catch {
      /* never break the page */
    }
  });
  addEventListener(
    "input",
    (e) => {
      try {
        if (pending && e.target === pending.t && read(pending.t) !== pending.value) pending.inputTook = true;
      } catch {
        /* never break the page */
      }
    },
    true,
  );
  addEventListener(
    "keyup",
    (e) => {
      try {
        if (pending && (e.code === pending.code || e.key === pending.key)) finish();
      } catch {
        /* never break the page */
      }
    },
    true,
  );
}
