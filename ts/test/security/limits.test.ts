// Availability limits (security rubric R5, probe P9): each declared cap refuses one unit over it before
// the body is parsed, and a second client's project-list GET still completes. Bounded and quick: one
// request per cap and form, and the stream caps at their exact values.
//
// "Before parsing": the over-cap body is not JSON, so a handler that parsed first would answer 422; a
// 413 shows the cap ran first. At exactly the cap the same bytes reach the parser (a non-413), which
// shows the test measures the constant the code applies.
import { connect } from "node:net";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openStream, send } from "../../../tools/devkit/security/lib/client.mjs";
import { MAX_AUTHORING_HTTP_BYTES } from "../../src/service/authoring-http.ts";
import { MAX_CLIENT_BATCH_BYTES } from "../../src/service/debug-http.ts";
import { MAX_COMMENTS_BODY_BYTES, MAX_PAIR_BODY_BYTES, MAX_SELECTION_BODY_BYTES } from "../../src/service/http.ts";
import { MAX_PROJECT_LIFECYCLE_BODY_BYTES } from "../../src/service/project-lifecycle.ts";
import { connectService, type ServiceClient } from "../../src/service/service-client.ts";
import { MAX_REQUEST_LINE_BYTES } from "../../src/service/socket.ts";
import { MAX_EVENT_STREAMS, MAX_EVENT_STREAMS_PER_GRANT } from "../../src/service/streams.ts";
import { MAX_NOTE_EMPHASIS_FILE_BYTES } from "../../../shared/note-emphasis.mts";
import { cleanUp, http, project, service, slugOf } from "../service/support.ts";

let origin = "",
  slug = "",
  ownerCookie = "",
  socketPath = "",
  cookie = "",
  control = "";
let client: ServiceClient;
const grants: { id: string; token: string }[] = [];

beforeAll(async () => {
  const { svc } = await service({ env: { ARCHER_DEBUG: "1" } });
  socketPath = svc.socketPath;
  client = await connectService(svc.socketPath);
  const attached = await client.call("attach", { root: project() });
  origin = new URL(svc.homeUrl).origin;
  slug = slugOf(attached.url);
  // The owner's browser: its agent link (the service token) exchanged for a session cookie.
  ownerCookie = ((await http(attached.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  const editor = await client.call("issueAccess", { label: "limits editor" });
  cookie = ((await http(editor.url)).headers["set-cookie"] as string[])[0]!.split(";")[0]!;
  control = (await client.call("issueAccess", { label: "second client" })).token;
  for (let i = 0; i < Math.ceil(MAX_EVENT_STREAMS / MAX_EVENT_STREAMS_PER_GRANT) + 1; i++)
    grants.push(await client.call("issueAccess", { label: `streams ${i}` }));
}, 30_000);
afterAll(async () => {
  client?.close();
  await cleanUp();
});

/** The second client: its project list answers while (and after) each probe runs. */
async function secondClientCompletes(): Promise<void> {
  const reply = await send(`${origin}/api/projects`, {
    headers: { authorization: `Bearer ${control}` },
    timeoutMs: 5_000,
  });
  expect(reply.status).toBe(200);
}

test("the caps are the constants the rubric names", () => {
  expect([MAX_EVENT_STREAMS, MAX_EVENT_STREAMS_PER_GRANT]).toEqual([32, 8]);
});

/** Each body cap: where it applies, the credential its route admits, and the constant. */
const caps = () => {
  const owner = `${origin}/p/${slug}/api`;
  const json = { origin, "content-type": "application/json" };
  const asOwner = { ...json, cookie: ownerCookie };
  return [
    {
      name: "MAX_PAIR_BODY_BYTES (/-/pair)",
      limit: MAX_PAIR_BODY_BYTES,
      method: "POST",
      url: `${origin}/-/pair`,
      headers: json,
    },
    {
      name: "MAX_COMMENTS_BODY_BYTES (comments)",
      limit: MAX_COMMENTS_BODY_BYTES,
      method: "POST",
      url: `${owner}/comments`,
      headers: asOwner,
    },
    {
      name: "MAX_SELECTION_BODY_BYTES (selection)",
      limit: MAX_SELECTION_BODY_BYTES,
      method: "POST",
      url: `${owner}/selection`,
      headers: asOwner,
    },
    {
      name: "MAX_SELECTION_BODY_BYTES (operations)",
      limit: MAX_SELECTION_BODY_BYTES,
      method: "POST",
      url: `${owner}/operations`,
      headers: asOwner,
    },
    {
      name: "walkthrough-position 1024",
      limit: 1024,
      method: "POST",
      url: `${owner}/walkthrough-position`,
      headers: asOwner,
    },
    {
      name: "MAX_LISTENER_BODY_BYTES (listeners/pin)",
      limit: 1024,
      method: "POST",
      url: `${owner}/listeners/pin`,
      headers: asOwner,
    },
    {
      name: "MAX_PROJECT_LIFECYCLE_BODY_BYTES",
      limit: MAX_PROJECT_LIFECYCLE_BODY_BYTES,
      method: "POST",
      url: `${owner}/project-lifecycle`,
      headers: asOwner,
    },
    {
      name: "MAX_NOTE_EMPHASIS_FILE_BYTES",
      limit: MAX_NOTE_EMPHASIS_FILE_BYTES,
      method: "POST",
      url: `${owner}/note-emphases`,
      headers: asOwner,
    },
    {
      name: "MAX_AUTHORING_HTTP_BYTES (authoring)",
      limit: MAX_AUTHORING_HTTP_BYTES,
      method: "POST",
      url: `${origin}/p/${slug}/api/authoring`,
      headers: { ...json, cookie },
    },
    {
      name: "MAX_CLIENT_BATCH_BYTES (/-/debug/events)",
      limit: MAX_CLIENT_BATCH_BYTES,
      method: "POST",
      url: `${origin}/-/debug/events`,
      headers: { ...json, cookie },
    },
  ];
};

test("each body cap refuses one byte over it, declared or chunked, before parsing; at the cap the parser answers", async () => {
  const seen: string[] = [];
  for (const cap of caps()) {
    const over = "x".repeat(cap.limit + 1),
      at = "x".repeat(cap.limit);
    const declared = await send(cap.url, { method: cap.method, headers: cap.headers, body: over });
    const chunked = await send(cap.url, {
      method: cap.method,
      headers: { ...cap.headers, "transfer-encoding": "chunked" },
      body: over,
      chunked: true,
    });
    const exact = await send(cap.url, { method: cap.method, headers: cap.headers, body: at });
    seen.push(`${cap.name}: over ${declared.status}/${chunked.status}, at ${exact.status === 413 ? 413 : "parsed"}`);
    await secondClientCompletes();
  }
  expect(seen).toEqual(caps().map((cap) => `${cap.name}: over 413/413, at parsed`));
}, 60_000);

test("a cookie header over 16 KiB is refused without a lookup", async () => {
  const reply = await send(`${origin}/api/projects`, { headers: { cookie: `${cookie}; pad=${"x".repeat(16_400)}` } });
  expect([404, 431]).toContain(reply.status);
  await secondClientCompletes();
});

test("a management line over MAX_REQUEST_LINE_BYTES closes that connection with request_too_large; other callers carry on", async () => {
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
    socket.write("x".repeat(MAX_REQUEST_LINE_BYTES + 1));
  });
  expect(JSON.parse(answer.trim().split("\n")[0]!)).toMatchObject({ ok: false, error: { code: "request_too_large" } });
  expect((await client.call("listProjects", {})).projects.length).toBe(1);
  await secondClientCompletes();
}, 20_000);

test(`one grant holds at most ${MAX_EVENT_STREAMS_PER_GRANT} streams and the service ${MAX_EVENT_STREAMS}; the next is refused and other clients still load`, async () => {
  const opened: { close(): void }[] = [];
  try {
    const open = async (grant: { token: string }) => {
      const stream = await openStream(`${origin}/p/${slug}/api/events`, {
        headers: { authorization: `Bearer ${grant.token}` },
      });
      opened.push(stream);
      return stream.status;
    };
    const first = grants[0]!;
    const perGrant: number[] = [];
    for (let i = 0; i < MAX_EVENT_STREAMS_PER_GRANT + 1; i++) perGrant.push(await open(first));
    expect(perGrant).toEqual([...Array(MAX_EVENT_STREAMS_PER_GRANT).fill(200), 503]);
    await secondClientCompletes();
    const total: number[] = [];
    fill: for (const grant of grants.slice(1))
      for (let i = 0; i < MAX_EVENT_STREAMS_PER_GRANT; i++) {
        const status = await open(grant);
        total.push(status);
        if (status !== 200) break fill;
      }
    // Admitted streams stop at the service cap: 8 on the first grant plus these.
    expect(MAX_EVENT_STREAMS_PER_GRANT + total.filter((s) => s === 200).length).toBe(MAX_EVENT_STREAMS);
    expect(total.at(-1)).toBe(503);
    await secondClientCompletes();
  } finally {
    for (const stream of opened) stream.close();
  }
}, 30_000);
