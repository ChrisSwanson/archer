import { readBrowserRoute } from "../../../shared/browser-routes.mts";

/** Static document address codec, selected only by the playground build. */
let documentAddress = new URL("https://playground.invalid/playground/app/index.html");
let snapshotDigest = "unconfigured";
const INVALID_PATH = "/__invalid-playground-route__";
const MAX_ADDRESS_CHARS = 32 * 1024;

export function configureStaticAddress(options: { documentUrl: string; digest: string }): void {
  const url = new URL(options.documentUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    !/\/playground\/app\/(?:index\.html)?$/u.test(url.pathname) ||
    !/^[A-Za-z0-9:_-]{1,200}$/u.test(options.digest)
  )
    throw new TypeError("invalid playground document configuration");
  if (url.pathname.endsWith("/")) url.pathname += "index.html";
  url.search = "";
  url.hash = "";
  documentAddress = url;
  snapshotDigest = options.digest;
}

/** Validate raw path spelling before URL can normalize dot segments. */
function rawPath(href: string): string | undefined {
  if (href.length > MAX_ADDRESS_CHARS || /[\u0000-\u0020\u007f\\]/u.test(href)) return undefined;
  return /^(?:https?:\/\/[^/?#]+)?(\/[^?#]*)/u.exec(href)?.[1];
}

function query(url: URL): string {
  // Preserve the live page's canonical bare `follow` key.
  return url.search.replace(/([?&])follow=(?=&|$)/u, "$1follow");
}

function invalidAddress(): string {
  return new URL(INVALID_PATH, documentAddress).href;
}

/** Turn a validated logical Archer address into a link to the fixed public document. */
export function encodeAddress(href: string): string {
  return encodeAddressFor(documentAddress, href);
}

/** The same encoding against an explicit document, for links built outside the page (the docs build). */
export function encodeAddressFor(document: URL, href: string): string {
  const path = rawPath(href);
  if (path === undefined || readBrowserRoute(path) === null) throw new TypeError("invalid playground route");
  const logical = new URL(href, document);
  if (logical.origin !== document.origin || logical.username !== "" || logical.password !== "")
    throw new TypeError("playground navigation must remain on its document origin");
  if (logical.searchParams.has("route")) throw new TypeError("reserved playground route parameter");
  const physical = new URL(document);
  physical.searchParams.set("route", path);
  for (const [key, value] of logical.searchParams) physical.searchParams.append(key, value);
  physical.hash = logical.hash;
  physical.search = query(physical);
  return physical.href;
}

/** Read untrusted query input without making an invalid address look like a valid project. */
export function decodeAddress(href: string): string {
  if (typeof href !== "string" || href.length > MAX_ADDRESS_CHARS) return invalidAddress();
  const path = rawPath(href);
  if (path === undefined) return invalidAddress();
  let physical: URL;
  try {
    physical = new URL(href, documentAddress);
  } catch {
    return invalidAddress();
  }
  if (physical.origin !== documentAddress.origin || physical.username !== "" || physical.password !== "")
    return invalidAddress();
  // Internal builders may already be working on the decoded logical address.
  if (readBrowserRoute(path, physical.search, physical.hash) !== null) return physical.href;
  if (path !== documentAddress.pathname && `${path}index.html` !== documentAddress.pathname) return invalidAddress();
  const routes = physical.searchParams.getAll("route");
  const route = routes.length === 0 ? "/projects/" : routes.length === 1 ? routes[0]! : "";
  if (readBrowserRoute(route, physical.search, physical.hash) === null) return invalidAddress();
  physical.pathname = route;
  physical.searchParams.delete("route");
  physical.search = query(physical);
  return physical.href;
}

/** Demo drafts/read state never share the live app's or the ordinary docs' keys. */
export const browserStateKey = (key: string): string => `archer:playground:${snapshotDigest}:${key}`;
