/**
 * Detectors for the security rubric's G7 probe (P6, docs/quality/rubrics/security.md): did any
 * content run as script, load, navigate, or clobber what the page reads?
 *
 *   canary      a write to `window.__xss` (every corpus payload writes it), in any frame
 *   dialog      an alert/confirm/prompt, in the page or a popup
 *   request     a request to anywhere but the service's origin (aborted, never sent)
 *   navigation  the tab leaving the service's origin, or any frame or popup at a script/data URL
 *   csp         a `securitypolicyviolation` event (a payload the policy stopped; not proof of XSS)
 *   sink        an inline event-handler attribute, or a `javascript:`/`vbscript:`/`data:text/html`
 *               URL attribute, anywhere in the DOM: a payload that reached the page but has not fired
 *   clobber     an element named or id'd after a global or document member the page reads
 *
 * `clickLinks` clicks every link that leaves the page (a script URL or another origin); a link that
 * opens a web page in a new tab, as note links are meant to, is not a hit, but the tab itself
 * navigating away, or a script URL running, is.
 */
import type { BrowserContext, Page, Request } from "@playwright/test";

export type Detector = "canary" | "dialog" | "request" | "navigation" | "csp" | "sink" | "clobber";
export const DETECTORS: readonly Detector[] = ["canary", "dialog", "request", "navigation", "csp", "sink", "clobber"];
export type Hit = { readonly detector: Detector; readonly detail: string; readonly where: string };

/** Globals and document members the page reads (grep `window.`/`document.` in ui/src), and ids it looks up. */
export const CLOBBER_NAMES = [
  "__archerTelemetry",
  "__xss",
  "root",
  "archer-walk-panel",
  "location",
  "fetch",
  "EventSource",
  "localStorage",
  "getElementById",
  "querySelector",
  "parentNode",
  "cookie",
  "defaultView",
  "body",
] as const;
/** Elements the page itself owns under one of those names. */
export const OWNED: Readonly<Record<string, number>> = { root: 1 };

export const SCRIPT_URL = /^\s*(?:javascript|vbscript|data:text\/html|data:image\/svg)/i;

export type Detectors = {
  readonly hits: Hit[];
  /** Name the phase hits are attributed to (the renderer and route under test). */
  at(where: string): void;
  /** Scan the DOM for the sink and clobber detectors. */
  scan(page: Page): Promise<void>;
  /** Click every link that leaves the page, then scan again. */
  clickLinks(page: Page, scope?: string): Promise<number>;
  /** Hits, per detector, since the start. */
  counts(): Record<Detector, number>;
};

/**
 * The sink and clobber scan of one document, run inside it (`page.evaluate(scanDocument, …)` or a frame's
 * `evaluate`): self-contained, so Playwright can ship it to any frame.
 */
export function scanDocument({
  names,
  owned,
}: {
  names: readonly string[];
  owned: Readonly<Record<string, number>>;
}): { detector: "sink" | "clobber"; detail: string }[] {
  const out: { detector: "sink" | "clobber"; detail: string }[] = [];
  const urlAttributes = ["href", "xlink:href", "src", "action", "formaction", "data", "srcdoc", "poster", "background"];
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      if (/^on[a-z]+$/.test(name))
        out.push({ detector: "sink", detail: `<${element.localName} ${name}="${attribute.value.slice(0, 80)}">` });
      else if (
        urlAttributes.includes(name) &&
        (/^\s*(?:javascript|vbscript|data:text\/html)/i.test(attribute.value) ||
          (element.localName !== "img" && /^\s*data:image\/svg/i.test(attribute.value)))
      )
        out.push({ detector: "sink", detail: `<${element.localName} ${name}="${attribute.value.slice(0, 80)}">` });
    }
    const tag = element.localName;
    if (tag === "script" && !element.closest("head") && element.getAttribute("type") !== "application/json")
      out.push({ detector: "sink", detail: "a <script> element in the body" });
    if (tag === "iframe" || tag === "object" || tag === "embed" || tag === "base" || tag === "foreignobject")
      out.push({ detector: "sink", detail: `a <${tag}> element` });
  }
  for (const name of names) {
    const named = document.querySelectorAll(`[id="${CSS.escape(name)}"],[name="${CSS.escape(name)}"]`).length;
    if (named > (owned[name] ?? 0))
      out.push({ detector: "clobber", detail: `${named} element(s) named or id'd "${name}"` });
  }
  if (typeof document.getElementById !== "function")
    out.push({ detector: "clobber", detail: "document.getElementById is not a function" });
  const telemetry = (window as unknown as Record<string, unknown>)["__archerTelemetry"];
  if (telemetry instanceof Element) out.push({ detector: "clobber", detail: "window.__archerTelemetry is an element" });
  return out;
}

export async function armDetectors(context: BrowserContext, page: Page, origin: string): Promise<Detectors> {
  const hits: Hit[] = [];
  let where = "start";
  const clicked = new Set<string>();
  const hit = (detector: Detector, detail: string): void => {
    hits.push({ detector, detail: detail.slice(0, 300), where });
  };

  await context.exposeBinding("__xssReport", (_source, detector: Detector, detail: string) =>
    hit(detector, String(detail)),
  );
  await context.addInitScript(() => {
    const report = (kind: string, detail: unknown): void => {
      try {
        void (window as unknown as { __xssReport(k: string, d: string): Promise<void> }).__xssReport(
          kind,
          String(detail),
        );
      } catch {
        /* the binding is gone with its page */
      }
    };
    // Every frame, iframes and popups included: `parent.__xss = …` lands in the parent's setter.
    Object.defineProperty(window, "__xss", {
      configurable: false,
      get: () => undefined,
      set: (value: unknown) => report("canary", value),
    });
    document.addEventListener(
      "securitypolicyviolation",
      (event) => report("csp", `${event.violatedDirective} ${event.blockedURI}`),
      true,
    );
  });

  const watchPage = (watched: Page, popup: boolean): void => {
    watched.on("dialog", (dialog) => {
      hit("dialog", `${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss().catch(() => {});
    });
    watched.on("framenavigated", (frame) => {
      const url = frame.url();
      if (SCRIPT_URL.test(url)) hit("navigation", `frame at ${url}`);
      else if (!popup && frame === watched.mainFrame() && !url.startsWith(origin) && url !== "about:blank")
        hit("navigation", `tab left for ${url}`);
    });
  };
  watchPage(page, false);
  context.on("page", (popup) => {
    watchPage(popup, true);
    const opened = popup.url();
    if (SCRIPT_URL.test(opened)) hit("navigation", `popup at ${opened}`);
    void popup.close().catch(() => {});
  });

  const expectedPopup = (request: Request): boolean => {
    // A web link opened in a new tab by a click is what notes promise; anything else leaving is a hit.
    if (!request.isNavigationRequest()) return false;
    let inThisTab: boolean;
    // A popup's first navigation can come before its frame exists: then it is not this tab's.
    try {
      inThisTab = request.frame().page() === page;
    } catch {
      inThisTab = false;
    }
    return !inThisTab && clicked.has(request.url());
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) return route.fallback();
    if (!expectedPopup(request)) hit("request", `${request.method()} ${url}`);
    await route.abort("blockedbyclient");
  });

  async function scan(target: Page): Promise<void> {
    if (target.isClosed() || !target.url().startsWith(origin)) return;
    const found = await target.evaluate(scanDocument, { names: [...CLOBBER_NAMES], owned: OWNED });
    for (const f of found) hit(f.detector, f.detail);
  }

  async function clickLinks(target: Page, scope = "body"): Promise<number> {
    if (target.isClosed() || !target.url().startsWith(origin)) return 0;
    const hrefs = await target.evaluate(
      ({ scope, origin }) => {
        const links = [...document.querySelectorAll(`${scope} a, ${scope} area`)];
        const leaving: number[] = [];
        const all: string[] = [];
        links.forEach((link, index) => {
          const href = link.getAttribute("href") ?? link.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
          all.push(href);
          let resolved: URL | null = null;
          try {
            resolved = new URL(href, document.baseURI);
          } catch {
            /* not a URL: still clicked */
          }
          if (resolved === null || resolved.origin !== origin) leaving.push(index);
        });
        (window as unknown as { __xssLinks?: Element[] }).__xssLinks = links;
        return leaving.map((index) => ({
          index,
          href: all[index]!,
          absolute: (() => {
            try {
              return new URL(all[index]!, document.baseURI).href;
            } catch {
              return all[index]!;
            }
          })(),
        }));
      },
      { scope, origin },
    );
    for (const { absolute } of hrefs) clicked.add(absolute);
    let count = 0;
    for (const { index } of hrefs) {
      if (target.isClosed() || !target.url().startsWith(origin)) break;
      // A synthetic activation: a `javascript:` href runs exactly as on a person's click.
      await target
        .evaluate((i) => {
          const link = (window as unknown as { __xssLinks?: Element[] }).__xssLinks?.[i];
          if (link === undefined) return;
          if (link instanceof HTMLElement) link.click();
          else link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }, index)
        .catch(() => {
          /* the click navigated the tab: the navigation detector has it */
        });
      count++;
    }
    await scan(target);
    return count;
  }

  return {
    hits,
    at(next) {
      where = next;
    },
    scan,
    clickLinks,
    counts() {
      const out = Object.fromEntries(DETECTORS.map((d) => [d, 0])) as Record<Detector, number>;
      for (const h of hits) out[h.detector]++;
      return out;
    },
  };
}

/** A hit list fit for a test message: one line each. */
export function describeHits(hits: readonly Hit[]): string {
  return hits.map((h) => `${h.detector} @ ${h.where}: ${h.detail}`).join("\n") || "(none)";
}
