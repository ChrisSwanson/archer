// In-page probes shared by the round-1 UI/UX tools. Each export is either an init script
// (`context.addInitScript(fn)`) or a function for `page.evaluate(fn, arg)`, so each must stay self-contained:
// no imports, no closure over this module.

/**
 * Live-region log (G9, 4.1.3): every change of text inside a live region after the document started, with its
 * politeness. A live region is `[aria-live]` (not "off"), or role status / alert / log / marquee / timer, or <output>.
 * Read back with `window.__liveLog` (events) and `window.__liveRegions()` (the regions now present, with their text).
 */
export function liveRegionRecorder() {
  if (window.__liveLog) return;
  const log = (window.__liveLog = []);
  const t0 = performance.now();
  const REGION =
    "[aria-live]:not([aria-live='off']), [role=status], [role=alert], [role=log], [role=marquee], [role=timer], output";
  const regionOf = (node) => (node instanceof Element ? node : node?.parentElement)?.closest?.(REGION) ?? null;
  const politeness = (r) =>
    r.getAttribute("aria-live") ??
    { alert: "assertive", status: "polite", log: "polite", timer: "off", marquee: "off" }[r.getAttribute("role")] ??
    (r.tagName === "OUTPUT" ? "polite" : "polite");
  const describe = (r) => ({
    tag: r.tagName.toLowerCase(),
    role: r.getAttribute("role") ?? undefined,
    id: r.id || undefined,
    cls: typeof r.className === "string" ? r.className.slice(0, 60) : undefined,
    label: r.getAttribute("aria-label") ?? undefined,
  });
  const text = (r) => (r.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  const last = new WeakMap();
  const start = () => {
    for (const r of document.querySelectorAll(REGION)) last.set(r, text(r));
    new MutationObserver((records) => {
      const touched = new Set();
      for (const rec of records) {
        const r = regionOf(rec.target);
        if (r) touched.add(r);
        for (const n of rec.addedNodes) {
          if (n instanceof Element && n.matches(REGION)) touched.add(n);
          else if (n instanceof Element) for (const inner of n.querySelectorAll(REGION)) touched.add(inner);
        }
      }
      for (const r of touched) {
        const now = text(r);
        if (last.get(r) === now) continue;
        const kind = last.has(r) ? "changed" : "added";
        last.set(r, now);
        if (now === "") continue; // a region mounting empty, or clearing, announces nothing
        log.push({
          t: Math.round(performance.now() - t0),
          kind,
          politeness: politeness(r),
          atomic: r.getAttribute("aria-atomic") ?? undefined,
          region: describe(r),
          text: now,
          hidden: !r.getClientRects().length,
        });
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-live", "role", "hidden"],
    });
  };
  if (document.documentElement) start();
  else addEventListener("DOMContentLoaded", start, { once: true });
  window.__liveRegions = () =>
    [...document.querySelectorAll(REGION)].map((r) => ({
      ...describe(r),
      politeness: politeness(r),
      text: text(r),
      visible: !!r.getClientRects().length,
    }));
}

/**
 * Viewport geometry and reflow (G8, V4): page-level horizontal overflow in CSS px, interactive controls that sit
 * outside the viewport horizontally (unreachable without two-way scrolling), and text clipped by its own box.
 * The drawing (`.react-flow`, the sequence and journey canvases) is 2-D content: its descendants are counted apart.
 */
export function pageGeometry() {
  const de = document.documentElement;
  const vw = window.innerWidth,
    vh = window.innerHeight;
  const scrollWidth = Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0);
  const CANVAS = ".react-flow, .archer-seq-canvas, .archer-journey, svg.archer-diagram";
  const CONTROL =
    "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=option], [role=treeitem], [tabindex]:not([tabindex='-1'])";
  const label = (el) =>
    (el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("title") ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  const path = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body && parts.length < 4; n = n.parentElement) {
      const cls =
        typeof n.className === "string" ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
      parts.unshift(n.tagName.toLowerCase() + (n.id ? `#${n.id}` : cls ? `.${cls}` : ""));
    }
    return parts.join(" > ");
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    return (
      s.visibility !== "hidden" &&
      s.display !== "none" &&
      el.getClientRects().length > 0 &&
      !el.closest("[aria-hidden='true'], [inert]")
    );
  };
  const outside = [];
  for (const el of document.querySelectorAll(CONTROL)) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const canvas = !!el.closest(CANVAS);
    let scroller = null;
    for (let n = el.parentElement; n && n !== document.body && n !== de; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX;
      if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth + 1) {
        scroller = path(n);
        break;
      }
    }
    // Off to the left, or starting past the right edge: reachable only by horizontal scrolling (or not at all).
    if (r.right <= 0 || r.left >= vw - 1 || r.right > vw + 1)
      outside.push({
        name: label(el),
        path: path(el),
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        canvas,
        inScroller: scroller,
        whollyOutside: r.right <= 0 || r.left >= vw - 1,
      });
  }
  // Text clipped by its own box: a text-bearing element whose content is wider than its box and that hides overflow.
  const clipped = [];
  for (const el of document.querySelectorAll("body *")) {
    if (clipped.length >= 50) break;
    if (!(el instanceof HTMLElement) || el.closest(CANVAS) || !visible(el)) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!ownText) continue;
    const s = getComputedStyle(el);
    const hides = /hidden|clip/.test(s.overflowX) || /hidden|clip/.test(s.overflow);
    if (hides && el.scrollWidth > el.clientWidth + 1)
      clipped.push({
        text: el.textContent.trim().slice(0, 60),
        path: path(el),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        ellipsis: s.textOverflow === "ellipsis",
      });
  }
  return {
    viewport: {
      width: vw,
      height: vh,
      devicePixelRatio: window.devicePixelRatio,
      visualViewport: window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            scale: window.visualViewport.scale,
          }
        : null,
    },
    pointer: {
      coarse: matchMedia("(pointer: coarse)").matches,
      fine: matchMedia("(pointer: fine)").matches,
      anyHover: matchMedia("(any-hover: hover)").matches,
    },
    colorScheme: {
      dark: matchMedia("(prefers-color-scheme: dark)").matches,
      dataTheme: de.getAttribute("data-theme"),
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    },
    document: {
      scrollWidth,
      scrollHeight: Math.max(de.scrollHeight, document.body?.scrollHeight ?? 0),
      clientWidth: de.clientWidth,
    },
    horizontalOverflowPx: Math.max(0, scrollWidth - de.clientWidth),
    controlsOutsideViewport: outside.filter((o) => !o.canvas),
    canvasControlsOutsideViewport: outside.filter((o) => o.canvas).length,
    clippedText: clipped,
  };
}
