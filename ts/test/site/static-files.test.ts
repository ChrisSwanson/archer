import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { lookupStatic, publicDirectoryIndex } from "../../../site/scripts/static-files.mts";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "archer-static-"));
  await mkdir(join(root, "playground/app"), { recursive: true });
  await mkdir(join(root, "empty"));
  await writeFile(join(root, "index.html"), "home");
  await writeFile(join(root, "install.html"), "install");
  await writeFile(join(root, "playground/app/index.html"), "app");
  await writeFile(join(root, "playground/app/main.js"), "js");
});
afterAll(() => rm(root, { recursive: true, force: true }));

it("maps addresses to files the way GitHub Pages serves the built site", () => {
  const at = (path: string, cleanUrls = true) => lookupStatic(root, "/archer/", path, { cleanUrls });
  expect(at("/archer/")).toEqual({ kind: "file", file: join(root, "index.html"), directoryIndex: true });
  expect(at("/archer/playground/app/")).toEqual({
    kind: "file",
    file: join(root, "playground/app/index.html"),
    directoryIndex: true,
  });
  expect(at("/archer/playground/app")).toEqual({ kind: "redirect", location: "/archer/playground/app/" });
  expect(at("/archer/playground/app/main.js")).toMatchObject({ file: join(root, "playground/app/main.js") });
  expect(at("/archer/install")).toMatchObject({ file: join(root, "install.html") });
  expect(at("/archer/install", false)).toBeNull();
  expect(at("/archer/empty/")).toBeNull();
  expect(at("/archer/missing")).toBeNull();
  expect(at("/archer/../etc/passwd")).toBeNull();
  expect(at("/archer/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  expect(at("/archer/%E0%A4%A")).toBeNull();
  expect(at("/elsewhere/install")).toBeNull();
  // Several bases share one tree; the longest matching base wins.
  expect(lookupStatic(root, ["/", "/archer/"], "/archer/install", { cleanUrls: true })).toMatchObject({
    file: join(root, "install.html"),
  });
  expect(lookupStatic(root, ["/", "/archer/"], "/install", { cleanUrls: true })).toMatchObject({
    file: join(root, "install.html"),
  });
});

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
function devMiddleware(): Middleware {
  let middleware: Middleware | undefined;
  const plugin = publicDirectoryIndex(root, "/archer/");
  const hook = plugin.configureServer as (server: unknown) => void;
  hook({ middlewares: { use: (handler: Middleware) => (middleware = handler) } });
  return middleware!;
}

it("lets the docs dev server open a public directory's index.html, as production does", () => {
  const middleware = devMiddleware();
  const request = (url: string) => {
    const message = { url } as IncomingMessage;
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 200,
      setHeader: (name: string, value: string) => (headers[name] = value),
      end: () => {},
    } as unknown as ServerResponse;
    let passed = false;
    middleware(message, response, () => (passed = true));
    return { url: message.url, passed, status: response.statusCode, headers };
  };
  expect(request("/archer/playground/app/?route=%2Fprojects%2F#x")).toMatchObject({
    url: "/archer/playground/app/index.html?route=%2Fprojects%2F",
    passed: true,
  });
  expect(request("/archer/playground/app?route=%2Fprojects%2F")).toMatchObject({
    passed: false,
    status: 301,
    headers: { location: "/archer/playground/app/?route=%2Fprojects%2F" },
  });
  // VitePress keeps its own pages, clean URLs and files.
  for (const url of ["/archer/", "/archer/install", "/archer/playground/app/main.js", "/archer/playground"])
    expect(request(url)).toMatchObject({ url, passed: true });
});
