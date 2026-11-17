// Round 1 (UI/UX) pass 2, batch F6 row d: the front door (`/`, the pairing page) and the refused page
// a browser meets without a credential are drawn in Archer's tokens. Each sets its own background and
// link colour in both colour schemes, so nothing is left to the browser's defaults (axe read the dark
// scheme's default link colour, #9e9eff, against an assumed white, P9), and its text is on the ramp.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AccessGrantStore } from "../../src/service/access-grants.ts";
import { handleRequest, type DataPlane } from "../../src/service/http.ts";
import { PAIRING_PAGE } from "../../src/service/pairing-page.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const TOKEN = "a".repeat(64);
const HOST = "127.0.0.1:40399";

function refusedPage(): string {
  const dir = mkdtempSync(join(tmpdir(), "archer-f6-"));
  dirs.push(dir);
  const plane = {
    token: TOKEN,
    grantStreams: new Map(),
    isStopping: () => false,
    page: () => Buffer.from("<html>app"),
    log: () => {},
    project: () => undefined,
    projects: () => [],
    authority: {
      serviceToken: TOKEN,
      grants: new AccessGrantStore(dir),
      cookieName: "archer-40399",
      secure: false,
      allowedHosts: new Set([HOST]),
    },
  } as unknown as DataPlane;
  let body = "";
  const req = {
    url: "/projects/shop/",
    method: "GET",
    headers: { host: HOST },
    socket: { remoteAddress: "127.0.0.1" },
    resume() {},
  } as unknown as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead() {
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) body = chunk.toString();
      return this;
    },
  } as unknown as ServerResponse;
  handleRequest(plane, req, res);
  return body;
}

const styleOf = (html: string): string => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
const rule = (css: string, selector: string): string =>
  new RegExp(`(?:^|[}\\s])${selector}\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

for (const [name, html] of [
  ["front door", () => PAIRING_PAGE.toString("utf8")],
  ["refused page", refusedPage],
] as const) {
  test(`the ${name} sets its own background, text and link colours in both schemes`, () => {
    const css = styleOf(html());
    expect(rule(css, "body")).toMatch(/background:var\(--bg\)/);
    expect(rule(css, "body")).toMatch(/color:var\(--text\)/);
    expect(rule(css, "a")).toMatch(/color:var\(--accent\)/);
    const dark = /@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const token of ["--bg", "--text", "--accent"]) expect(dark, token).toContain(`${token}:`);
  });

  test(`the ${name} sets its text on Archer's type ramp`, () => {
    const css = styleOf(html());
    const sizes = [...css.matchAll(/font-size:([^;}]+)/g)]
      .map((m) => m[1]!.trim())
      .concat([...css.matchAll(/(?:^|[{;])font:([^;}]+)/g)].map((m) => m[1]!.trim()).filter((v) => v !== "inherit"));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toMatch(/var\(--type-(small|body|title|display)\)|^inherit$/);
  });
}

test("both pages share one stylesheet", () => {
  expect(styleOf(refusedPage())).toBe(styleOf(PAIRING_PAGE.toString("utf8")));
});
