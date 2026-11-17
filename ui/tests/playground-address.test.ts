import { afterEach, describe, expect, it, vi } from "vitest";
import { readBrowserRoute } from "../../shared/browser-routes.mts";
import {
  browserStateKey,
  configureStaticAddress,
  decodeAddress,
  encodeAddress,
  encodeAddressFor,
} from "../src/playground/address";
import { browserRoutePath, projectResourceBase, readLocationRoute } from "../src/app/browser-routes";
import { readPageAddress, searchPageHref, withPageAddress } from "../src/app/page-address";
import { directoryProjectUrl, projectSlugFromPath } from "../src/app/project-directory";
import { EMPTY_SEARCH } from "../src/app/file-index";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";

vi.mock("../src/runtime/address.ts", async () => await import("../src/playground/address"));

describe.each(["/", "/archer/"])("playground addresses at %s", (base) => {
  const origin = "https://example.test";
  const documentUrl = `${origin}${base}playground/app/index.html`;
  const setup = () => configureStaticAddress({ documentUrl, digest: "sha256:abc" });

  it("accepts the Pages directory address and canonicalizes shared links to index.html", () => {
    const directory = `${origin}${base}playground/app/`;
    configureStaticAddress({ documentUrl: `${directory}?route=%2Fprojects%2Ftour%2F#purpose`, digest: "sha256:abc" });
    expect(decodeAddress(directory)).toBe(`${origin}/projects/`);
    expect(decodeAddress(`${directory}?route=%2Fprojects%2Ftour%2F#purpose`)).toBe(`${origin}/projects/tour/#purpose`);
    expect(encodeAddress("/projects/tour/")).toBe(`${documentUrl}?route=%2Fprojects%2Ftour%2F`);
    expect(decodeAddress(encodeAddress("/projects/tour/"))).toBe(`${origin}/projects/tour/`);
  });

  it("encodes build-time links against an explicit document exactly as the page does", () => {
    setup();
    const other = new URL(`https://docs.invalid${base}playground/app/index.html`);
    for (const logical of ["/projects/tour/", "/projects/tour/diagrams/containers.mmd", "/projects/tour/notes/a.md"])
      expect(encodeAddressFor(other, logical).replace("https://docs.invalid", origin)).toBe(encodeAddress(logical));
    expect(() => encodeAddressFor(other, "/not-a-route")).toThrow(TypeError);
    // The page's configured document is untouched.
    expect(encodeAddress("/projects/tour/")).toBe(`${documentUrl}?route=%2Fprojects%2Ftour%2F`);
  });

  it("keeps every logical destination in the one deployed document", () => {
    setup();
    for (const logical of [
      "/projects/",
      "/projects/tour/?follow&view=containers",
      "/projects/tour/diagrams/containers.mmd?thread=thr_abc",
      "/projects/tour/notes/architecture.md#login",
      "/projects/ipoac/notes/?tab=notes&q=bird",
    ]) {
      const physical = new URL(encodeAddress(`${origin}${logical}`));
      expect(physical.origin + physical.pathname).toBe(documentUrl);
      expect(physical.searchParams.get("route")).toBe(new URL(logical, origin).pathname);
      expect(decodeAddress(physical.href)).toBe(`${origin}${logical}`);
    }
  });

  it("uses the project list when the document has no route", () => {
    setup();
    expect(decodeAddress(documentUrl)).toBe(`${origin}/projects/`);
  });

  it("quarantines malformed, repeated and foreign route input", () => {
    setup();
    for (const route of [
      "//evil.test/projects/tour/",
      "/projects/tour/../secret.md",
      "/projects/tour/%2e%2e/",
      "/projects/tour/a.md?view=x",
      "/projects/tour/%00.md",
    ]) {
      const decoded = new URL(decodeAddress(`${documentUrl}?route=${encodeURIComponent(route)}`));
      expect(readBrowserRoute(decoded.pathname, decoded.search, decoded.hash), route).toBeNull();
    }
    for (const url of [
      `${documentUrl}?route=/projects/tour/&route=/projects/ipoac/`,
      `https://foreign.test${base}playground/app/index.html?route=/projects/tour/`,
    ]) {
      const decoded = new URL(decodeAddress(url));
      expect(readBrowserRoute(decoded.pathname, decoded.search, decoded.hash)).toBeNull();
    }
  });

  it("rejects foreign or malformed navigation before URL normalization", () => {
    setup();
    expect(() => encodeAddress("https://foreign.test/projects/tour/")).toThrow(TypeError);
    expect(() => encodeAddress(`${origin}/projects/tour/../ipoac/`)).toThrow(TypeError);
    expect(() => encodeAddress(`${origin}/projects/tour/%2e%2e/ipoac/`)).toThrow(TypeError);
  });

  it("namespaces browser state by snapshot and leaves another snapshot separate", () => {
    setup();
    expect(browserStateKey("archer:comment-drafts")).toBe("archer:playground:sha256:abc:archer:comment-drafts");
    configureStaticAddress({ documentUrl, digest: "sha256:def" });
    expect(browserStateKey("archer:comment-drafts")).toBe("archer:playground:sha256:def:archer:comment-drafts");
  });

  it("uses the same codec for App routes, project switching and request scope", () => {
    setup();
    const here = new URL(encodeAddress(`${origin}/projects/tour/diagrams/containers.mmd`));
    vi.stubGlobal("window", { location: here });
    expect(readLocationRoute(here.pathname)).toEqual({
      kind: "file",
      projectSlug: "tour",
      path: "diagrams/containers.mmd",
    });
    expect(projectSlugFromPath(here.pathname)).toBe("tour");
    expect(projectResourceBase(here.href)).toBe(`${origin}/p/tour/`);
    expect(browserRoutePath({ kind: "note", projectSlug: "tour", path: "notes/architecture.md" })).toBe(
      `${base}playground/app/index.html?route=%2Fprojects%2Ftour%2Fnotes%2Farchitecture.md`,
    );
    const switched = new URL(directoryProjectUrl(here.href, "ipoac", { note: "notes/flight.md" })!);
    expect(switched.pathname).toBe(here.pathname);
    expect(decodeAddress(switched.href)).toBe(`${origin}/projects/ipoac/notes/flight.md`);
  });

  it("keeps App address writes, search and embedded figures reloadable", () => {
    setup();
    const here = encodeAddress(`${origin}/projects/tour/?follow&view=containers`);
    const next = new URL(withPageAddress(here, { kind: "view", viewId: "notes/architecture.md#login" }));
    expect(next.origin + next.pathname).toBe(documentUrl);
    expect(readPageAddress(next.search, next.pathname, { hash: next.hash })).toEqual({
      kind: "view",
      viewId: "notes/architecture.md#login",
    });
    const search = new URL(
      searchPageHref(next.href, { ...EMPTY_SEARCH, query: "bird", projects: ["ipoac"], tab: "notes" }),
    );
    expect(search.origin + search.pathname).toBe(documentUrl);
    expect(decodeAddress(search.href)).toContain("/projects/ipoac/?q=bird");
  });
});

afterEach(() => vi.unstubAllGlobals());

it("refuses or reads arbitrary route bytes on a small stack within a clock bound", () => {
  const directory = mkdtempSync(join(tmpdir(), "archer-playground-address-"));
  try {
    const modulePath = join(directory, "address.cjs");
    buildSync({
      entryPoints: [resolve(import.meta.dirname, "../src/playground/address.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: modulePath,
      logLevel: "silent",
    });
    const script = `
const assert = require('node:assert/strict');
const { configureStaticAddress, decodeAddress, encodeAddress } = require(${JSON.stringify(modulePath)});
configureStaticAddress({documentUrl:'https://example.test/archer/playground/app/index.html',digest:'sha256:abc'});
let seed = 4817;
const random = () => (seed = (Math.imul(seed,1664525)+1013904223)>>>0);
const vocabulary = ['projects','tour','notes','%2e%2e','..','%00','%2F','%5C','%ZZ','a.md','?','#','/','架構',''];
const check = value => {
  const physical = 'https://example.test/archer/playground/app/index.html?'+new URLSearchParams({route:value});
  const decoded = decodeAddress(physical);
  assert.equal(typeof decoded,'string');
  if (!decoded.includes('/__invalid-playground-route__')) {
    assert.equal(decodeAddress(encodeAddress(decoded)),decoded);
  }
};
for(let i=0;i<6000;i++) {
  let arbitrary=''; for(let j=0;j<24;j++) arbitrary+=String.fromCharCode(random()%65536);
  check(arbitrary);
  check('/'+Array.from({length:1+random()%7},()=>vocabulary[random()%vocabulary.length]).join('/'));
  const original='/projects/tour/notes/architecture.md'; const index=random()%original.length;
  check(original.slice(0,index)+vocabulary[random()%vocabulary.length]+original.slice(index+1));
}
check('/projects/tour/'+('x/'.repeat(20000)));
process.stdout.write('18001 boundary cases passed');`;
    expect(
      execFileSync(process.execPath, ["--stack-size=192", "-e", script], { encoding: "utf8", timeout: 10000 }),
    ).toContain("18001 boundary cases passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
