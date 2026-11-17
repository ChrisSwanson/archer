import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { connectService, type ServiceClient } from "../../src/service/index.ts";
import { asOwner, cleanUp, events, exactly, FLOW2, http, json, project, service, write, apiBase } from "./support.ts";

const clients: ServiceClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await cleanUp();
});

/** Background drawing is off unless asked for, so a test counts only the drawings its requests made. */
async function attached(prefetchThumbnails = false, env: Record<string, string> = {}) {
  const { svc, state } = await service({ prefetchThumbnails, env });
  const client = await connectService(svc.socketPath);
  clients.push(client);
  const root = project();
  write(
    root,
    ".archer/auth.md",
    "# Auth\n\n```mermaid\n%% archer-id: login\nflowchart LR\n  user[User] e1@--> app[App]\n```\n",
  );
  // The attach URL is the clean page address; the project API lives at its resource base.
  const url = apiBase((await client.call("attach", { root })).url);
  const cache = join(state, "cache", "thumbnails");
  return { svc, root, url, cache };
}

type View = { id: string; modelRevision?: string };
type Inventory = { views: View[]; thumbnailVersion?: string; thumbnailFormat?: string };
const inventory = async (url: string): Promise<Inventory> => (await json(`${url}api/diagrams`)) as Inventory;
const views = async (url: string): Promise<View[]> => (await inventory(url)).views;
/** The page's spelling of a thumbnail address: the drawing's revision, theme and the painter's version. */
const thumb = async (url: string, id: string, rev: string, theme: "light" | "dark"): Promise<string> =>
  `${url}api/thumbnails/${encodeURIComponent(id)}?rev=${rev}&theme=${theme}&v=${(await inventory(url)).thumbnailVersion}`;
const thumbnails = (cache: string): string[] =>
  existsSync(cache) ? readdirSync(cache).filter((name) => name.endsWith(".thumb")) : [];
/** The raw bytes and headers of one GET by the owner's browser (the shared helper decodes the body as text). */
const raw = async (
  url: string,
  given: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> => {
  const headers = await asOwner(url, "GET", given);
  return new Promise((resolve, reject) => {
    request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    })
      .on("error", reject)
      .end();
  });
};

test("the inventory names each compiled view's model revision", async () => {
  const { url } = await attached();
  const listed = await views(url);
  for (const view of listed) expect(view.modelRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
  const envelope = (await json(`${url}api/diagrams/flow`)) as { revision: string };
  expect(listed.find((view) => view.id === "flow")?.modelRevision).toBe(envelope.revision);
});

test("a thumbnail at the current revision is an immutable, sandboxed SVG with one ETag for its encodings", async () => {
  const { url, cache } = await attached();
  const rev = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  const reply = await http(await thumb(url, "flow", rev, "dark"));
  expect(reply.status).toBe(200);
  expect(reply.headers["content-type"]).toBe("image/svg+xml");
  expect(reply.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  expect(reply.headers["etag"]).toMatch(/^W\/"[0-9a-f]{64}"$/);
  expect(reply.headers["vary"]).toBe("accept-encoding");
  expect(reply.headers["content-encoding"]).toBeUndefined();
  expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  expect(reply.headers["content-security-policy"]).toContain("default-src 'none'");
  expect(reply.headers["content-security-policy"]).toContain("sandbox");
  expect(reply.body.startsWith("<svg ")).toBe(true);
  expect(reply.body).toContain('data-element-id="a"');
  expect(reply.body).not.toMatch(/<script|font\/woff2/);
  expect(thumbnails(cache)).toHaveLength(1);

  const revalidated = await http(await thumb(url, "flow", rev, "dark"), {
    headers: { "if-none-match": reply.headers["etag"] as string },
  });
  expect(revalidated.status).toBe(304);
  expect(revalidated.body).toBe("");
  const light = await http(await thumb(url, "flow", rev, "light"));
  expect(light.status).toBe(200);
  expect(light.headers["etag"]).not.toBe(reply.headers["etag"]);
});

test("an embedded diagram's address is one encoded path segment", async () => {
  const { url } = await attached();
  const rev = (await views(url)).find((view) => view.id === "auth.md#login")!.modelRevision!;
  const reply = await http(await thumb(url, "auth.md#login", rev, "light"));
  expect(reply.status).toBe(200);
  expect(reply.body).toContain('data-element-id="user"');
});

test("a stale revision redirects, uncached, to the current one; after an edit the new revision draws the new model", async () => {
  const { url, root } = await attached();
  const before = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  const stream = await events(`${url}api/events`);
  try {
    write(root, ".archer/flow.mmd", FLOW2);
    await stream.next("change");
  } finally {
    stream.close();
  }
  const after = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  expect(after).not.toBe(before);
  const { thumbnailVersion } = await inventory(url);
  const stale = await http(await thumb(url, "flow", before, "dark"));
  expect(stale.status).toBe(302);
  expect(stale.headers["cache-control"]).toBe("no-store");
  expect(stale.headers["location"]).toBe(`flow?rev=${after}&theme=dark&v=${thumbnailVersion}`);
  const current = await http(new URL(stale.headers["location"] as string, `${url}api/thumbnails/flow`).href);
  expect(current.status).toBe(200);
  expect(current.body).toContain('data-element-id="c"');
});

test("the painter's version is part of the address: an upgrade's previews are fetched afresh", async () => {
  const { url } = await attached();
  const { views: listed, thumbnailVersion } = await inventory(url);
  expect(thumbnailVersion).toMatch(/^[0-9a-f]{12}$/);
  const catalog = (await json(`${url}api/browser-projects`)) as { thumbnailVersion?: string };
  expect(catalog.thumbnailVersion).toBe(thumbnailVersion);
  const rev = listed.find((view) => view.id === "flow")!.modelRevision!;
  // Without the version, or with another painter's, an uncached redirect to this painter's address.
  for (const other of ["", "&v=000000000000", "&v=junk"]) {
    const reply = await http(`${url}api/thumbnails/flow?rev=${rev}&theme=dark${other}`);
    expect(reply.status).toBe(302);
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(reply.headers["location"]).toBe(`flow?rev=${rev}&theme=dark&v=${thumbnailVersion}`);
  }
  expect((await http(await thumb(url, "flow", rev, "dark"))).status).toBe(200);
});

test.each([
  ["a missing revision", "flow?theme=dark", 422],
  ["a malformed revision", "flow?rev=sha256:xyz&theme=dark", 422],
  ["an unknown theme", `flow?rev=sha256:${"0".repeat(64)}&theme=sepia`, 422],
  ["an unknown view", `nope?rev=sha256:${"0".repeat(64)}&theme=dark`, 404],
  ["a view id that is not one", `${encodeURIComponent("../x")}?rev=sha256:${"0".repeat(64)}&theme=dark`, 404],
])("%s is refused without drawing", async (_name, path, status) => {
  const { url, cache } = await attached();
  const reply = await http(`${url}api/thumbnails/${path}`);
  expect(reply.status).toBe(status);
  expect(reply.headers["cache-control"]).toBe("no-store");
  expect(thumbnails(cache)).toEqual([]);
});

test("arbitrary ids and queries are refused or answered, and only a valid current request draws", async () => {
  const { url, cache } = await attached();
  const rev = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  let seed = 2026;
  const random = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const ids = [
    "flow",
    "chat",
    "auth.md#login",
    "auth.md",
    "",
    "..",
    "%",
    "%00",
    "a/b",
    "flow ",
    "\u{1F600}",
    "x".repeat(300),
  ];
  const revs = [rev, rev.toUpperCase(), rev.slice(0, -1), `${rev}0`, "", "sha256:", `sha256:${"g".repeat(64)}`];
  const themes = ["dark", "light", "", "DARK", "dark&theme=light"];
  const seen = new Set<number>();
  for (let n = 0; n < 120; n++) {
    const id = ids[random(ids.length)]!,
      r = revs[random(revs.length)]!,
      theme = themes[random(themes.length)]!;
    const encoded = random(4) === 0 ? id : encodeURIComponent(id);
    const query =
      random(5) === 0 ? `theme=${theme}&rev=${r}&rev=${rev}` : `rev=${encodeURIComponent(r)}&theme=${theme}`;
    const reply = await http(`${url}api/thumbnails/${encoded}?${query}`);
    expect([200, 302, 404, 422]).toContain(reply.status);
    seen.add(reply.status);
  }
  expect(seen.has(422)).toBe(true);
  // At most one drawing per (view, theme) at its current revision.
  expect(thumbnails(cache).length).toBeLessThanOrEqual(6);
});

test("a request without the credential gets a bare 404 and draws nothing", async () => {
  const { url, cache } = await attached();
  const rev = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  const reply = await exactly(await thumb(url, "flow", rev, "dark"));
  expect(reply.status).toBe(404);
  expect(reply.body).toBe("");
  expect(thumbnails(cache)).toEqual([]);
});

test("thumbnails are drawn in the background at attach and again when a view's revision changes", async () => {
  const { root, url, cache } = await attached(true, { ARCHER_THUMBNAIL_FORMAT: "png" });
  const settle = async (expected: number): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (thumbnails(cache).length < expected && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
  };
  // flow, chat and the embedded login: light and dark each, without any request for them.
  await settle(6);
  expect(thumbnails(cache)).toHaveLength(6);
  // With png chosen, each background drawing kept every variant: the SVG, its two copies and the PNG.
  for (const name of thumbnails(cache)) {
    const file = readFileSync(join(cache, name));
    const header = JSON.parse(file.subarray(0, file.indexOf(10)).toString()) as Record<string, number>;
    for (const part of ["svg", "br", "gzip", "png"]) expect(header[part], `${name} ${part}`).toBeGreaterThan(0);
  }
  const before = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  write(root, ".archer/flow.mmd", FLOW2);
  const deadline = Date.now() + 10_000;
  while ((await views(url)).find((view) => view.id === "flow")!.modelRevision === before && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  await settle(8);
  expect(thumbnails(cache)).toHaveLength(8);
}, 40_000);

test("the SVG is sent as the reader accepts it, from copies made when it was drawn; one validator answers 304 for each", async () => {
  const { url, cache } = await attached();
  const rev = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  const address = await thumb(url, "flow", rev, "dark");
  const identity = await raw(address);
  expect(identity.headers["content-encoding"]).toBeUndefined();
  const cases = [
    ["br, gzip, deflate", "br"],
    ["gzip", "gzip"],
    ["gzip;q=1, br;q=0", "gzip"],
    ["identity", undefined],
    ["br;q=0, gzip;q=0", undefined],
  ] as const;
  for (const [accept, coding] of cases) {
    const reply = await raw(address, { "accept-encoding": accept });
    expect(reply.status, accept).toBe(200);
    expect(reply.headers["content-encoding"], accept).toBe(coding);
    expect(reply.headers["vary"]).toBe("accept-encoding");
    expect(reply.headers["etag"]).toBe(identity.headers["etag"]);
    expect(Number(reply.headers["content-length"])).toBe(reply.body.length);
    const decoded =
      coding === "br" ? brotliDecompressSync(reply.body) : coding === "gzip" ? gunzipSync(reply.body) : reply.body;
    expect(decoded.equals(identity.body), accept).toBe(true);
    if (coding !== undefined) expect(reply.body.length).toBeLessThan(identity.body.length / 2);
  }
  // The validator of one encoding revalidates every other, in either spelling.
  const tag = identity.headers["etag"] as string;
  for (const [accept, match] of [
    ["br", tag],
    ["gzip", tag],
    ["", tag.replace(/^W\//, "")],
    ["br", `"other", ${tag}`],
  ]) {
    const reply = await raw(address, { "accept-encoding": accept!, "if-none-match": match! });
    expect(reply.status, `${accept} ${match}`).toBe(304);
    expect(reply.headers["etag"]).toBe(tag);
    expect(reply.headers["vary"]).toBe("accept-encoding");
    expect(reply.body.length).toBe(0);
  }
  expect(thumbnails(cache)).toHaveLength(1);
});

const pngSize = (bytes: Buffer): [number, number] => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

test("format=png answers the same drawing as an immutable PNG with its own validator; format=svg is the default", async () => {
  const { url, cache } = await attached(false, { ARCHER_THUMBNAIL_FORMAT: "png" });
  const rev = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  const address = await thumb(url, "flow", rev, "light");
  const svg = await raw(address);
  const explicit = await raw(`${address}&format=svg`);
  expect(explicit.body.equals(svg.body)).toBe(true);
  const reply = await raw(`${address}&format=png`, { "accept-encoding": "br, gzip" });
  expect(reply.status).toBe(200);
  expect(reply.headers["content-type"]).toBe("image/png");
  expect(reply.headers["content-encoding"]).toBeUndefined();
  expect(reply.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  expect(reply.headers["etag"]).toMatch(/^"[0-9a-f]{64}-png"$/);
  expect(reply.headers["etag"]).not.toBe(svg.headers["etag"]);
  expect([...reply.body.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const [width, height] = pngSize(reply.body);
  expect(width === 640 || height === 360).toBe(true);
  expect(width).toBeLessThanOrEqual(640);
  expect(height).toBeLessThanOrEqual(360);
  const revalidated = await raw(`${address}&format=png`, { "if-none-match": reply.headers["etag"] as string });
  expect(revalidated.status).toBe(304);
  // The SVG's validator does not revalidate the PNG.
  expect((await raw(`${address}&format=png`, { "if-none-match": svg.headers["etag"] as string })).status).toBe(200);
  // One drawing made both.
  expect(thumbnails(cache)).toHaveLength(1);
});

test("a PNG address is refused and redirected as an SVG one is, keeping its format", async () => {
  const { url, root, cache } = await attached(false, { ARCHER_THUMBNAIL_FORMAT: "png" });
  const before = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  expect((await http(`${url}api/thumbnails/flow?rev=${before}&theme=dark&format=webp`)).status).toBe(422);
  expect((await http(`${url}api/thumbnails/flow?rev=${before}&theme=sepia&format=png`)).status).toBe(422);
  expect((await http(`${url}api/thumbnails/nope?rev=${before}&theme=dark&format=png`)).status).toBe(404);
  expect(thumbnails(cache)).toEqual([]);
  const stream = await events(`${url}api/events`);
  try {
    write(root, ".archer/flow.mmd", FLOW2);
    await stream.next("change");
  } finally {
    stream.close();
  }
  const { views: listed, thumbnailVersion } = await inventory(url);
  const after = listed.find((view) => view.id === "flow")!.modelRevision!;
  const stale = await http(`${url}api/thumbnails/flow?rev=${before}&theme=dark&v=${thumbnailVersion}&format=png`);
  expect(stale.status).toBe(302);
  expect(stale.headers["cache-control"]).toBe("no-store");
  expect(stale.headers["location"]).toBe(`flow?rev=${after}&theme=dark&v=${thumbnailVersion}&format=png`);
  const unversioned = await http(`${url}api/thumbnails/flow?rev=${after}&theme=dark&format=png`);
  expect(unversioned.headers["location"]).toBe(`flow?rev=${after}&theme=dark&v=${thumbnailVersion}&format=png`);
  const current = await raw(new URL(stale.headers["location"] as string, `${url}api/thumbnails/flow`).href);
  expect(current.status).toBe(200);
  expect(current.headers["content-type"]).toBe("image/png");
});

test("a PNG request without the credential gets a bare 404 and draws nothing", async () => {
  const { url, cache } = await attached();
  const rev = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  const reply = await exactly(`${await thumb(url, "flow", rev, "dark")}&format=png`);
  expect(reply.status).toBe(404);
  expect(reply.body).toBe("");
  expect(thumbnails(cache)).toEqual([]);
});

test("the inventory and the project catalog name the format pages should ask for: png by default (labels in their weight, faster to show), svg when chosen", async () => {
  const { url } = await attached();
  expect((await inventory(url)).thumbnailFormat).toBe("png");
  expect(((await json(`${url}api/browser-projects`)) as { thumbnailFormat?: string }).thumbnailFormat).toBe("png");
  await cleanUp();
  const svg = await attached(false, { ARCHER_THUMBNAIL_FORMAT: "svg" });
  expect((await inventory(svg.url)).thumbnailFormat).toBe("svg");
  expect(((await json(`${svg.url}api/browser-projects`)) as { thumbnailFormat?: string }).thumbnailFormat).toBe("svg");
});

test("only the chosen format is drawn: an svg service refuses a PNG address and keeps no PNG", async () => {
  const { url, cache } = await attached(false, { ARCHER_THUMBNAIL_FORMAT: "svg" });
  const rev = (await views(url)).find((view) => view.id === "flow")!.modelRevision!;
  const address = await thumb(url, "flow", rev, "light");
  expect((await raw(`${address}&format=png`)).status).not.toBe(200);
  expect((await raw(address)).status).toBe(200);
  for (const name of thumbnails(cache)) {
    const file = readFileSync(join(cache, name));
    expect((JSON.parse(file.subarray(0, file.indexOf(10)).toString()) as Record<string, number>)["png"]).toBe(0);
  }
});

test("an unknown ARCHER_THUMBNAIL_FORMAT is refused at start", async () => {
  await expect(service({ env: { ARCHER_THUMBNAIL_FORMAT: "webp" } })).rejects.toThrow(/ARCHER_THUMBNAIL_FORMAT/);
});
