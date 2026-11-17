import { afterEach, expect, it, vi } from "vitest";
import { POLL_HEADER } from "../src/app/polls";
import {
  type Answer,
  bodyOf,
  createResourceStore,
  type ResourcePolicy,
  type Superseded,
  type Transport,
} from "../src/app/resources";

type Call = { readonly url: string; readonly init: RequestInit };
/** A transport whose answers the test releases, recording each request. */
function service() {
  const calls: Call[] = [];
  const held: ((response: Response) => void)[] = [];
  const transport: Transport = (url, init) => {
    calls.push({ url, init });
    return new Promise<Response>((resolve) => held.push(resolve));
  };
  return { calls, transport, answer: (index: number, response: Response) => held[index]!(response) };
}
const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers });
const header = (call: Call | undefined, name: string): string | null => new Headers(call?.init.headers).get(name);
const policy = <T = unknown>(extra: Partial<ResourcePolicy<T>> = {}): ResourcePolicy<T> => ({
  kind: "catalog",
  freshMs: 1000,
  parse: (raw, response) => (response.ok ? (raw as T) : undefined),
  ...extra,
});
const limits = { maxEntries: 64, maxBytes: 8 * 1024 * 1024 };
const answered = <T>(result: Answer<T> | Superseded<T>): Answer<T> => {
  if ("superseded" in result) throw new Error("superseded");
  return result;
};

let now = 1_000_000;
const clock = () => vi.spyOn(Date, "now").mockImplementation(() => now);
afterEach(() => vi.restoreAllMocks());

it("concurrent reads of a key share one request; inside freshMs the answer is held; after it, read again", async () => {
  clock();
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const reads = [1, 2, 3].map(() => store.read("k", policy()));
  expect(calls).toHaveLength(1);
  answer(0, json({ n: 1 }));
  const [a, b, c] = await Promise.all(reads);
  expect(b).toBe(a);
  expect(c).toBe(a);
  expect(answered(a!).body).toEqual({ n: 1 });
  now += 999;
  expect(await store.read("k", policy())).toBe(a);
  now += 1;
  const again = store.read("k", policy());
  expect(calls).toHaveLength(2);
  answer(1, json({ n: 2 }));
  expect(answered(await again).body).toEqual({ n: 2 });
  expect(store.peek("k")?.body).toEqual({ n: 2 });
});

it("only the read that starts a request tags it with its tick; a joining tick makes none", async () => {
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const first = store.read("k", policy(), { poll: { [POLL_HEADER]: "notifications#1" } });
  const joined = store.read("k", policy(), { poll: { [POLL_HEADER]: "notifications#2" } });
  const plain = store.read("k", policy());
  expect(calls).toHaveLength(1);
  expect(header(calls[0], POLL_HEADER)).toBe("notifications#1");
  expect(calls[0]!.init.cache).toBe("no-store");
  answer(0, json(1));
  expect(await joined).toBe(await first);
  expect(await plain).toBe(await first);
});

it("a failed read is forgotten at once: the next reader asks again", async () => {
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const failed = store.read("k", policy());
  answer(0, new Response("", { status: 500 }));
  await expect(failed).rejects.toThrow(/HTTP 500/);
  expect(store.peek("k")).toBeUndefined();
  const next = store.read("k", policy());
  expect(calls).toHaveLength(2);
  answer(1, json("ok"));
  expect(answered(await next).body).toBe("ok");
});

it("a policy's own error stands, and a body it refuses fails the read", async () => {
  const { transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const refused = store.read(
    "a",
    policy({
      parse: () => {
        throw new Error("refused: gone");
      },
    }),
  );
  answer(0, json({}));
  await expect(refused).rejects.toThrow("refused: gone");
  const unreadable = store.read("b", policy({ parse: () => undefined }));
  answer(1, json({}));
  await expect(unreadable).rejects.toThrow(/no answer/);
});

it("supersede: a read out when its kind changes lands Superseded (with what it was told), never held or heard", async () => {
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const heard: unknown[] = [];
  store.subscribe("k", (a) => heard.push(a.body));
  const before = store.read("k", policy());
  store.supersede("catalog");
  const after = store.read("k", policy());
  expect(calls).toHaveLength(2);
  answer(1, json("new"));
  expect(answered(await after).body).toBe("new");
  answer(0, json("old"));
  const late = await before;
  expect("superseded" in late && late.superseded).toBe(true);
  expect(bodyOf(late)).toBe("old");
  expect(store.peek("k")?.body).toBe("new");
  expect(heard).toEqual(["new"]);
  // Another kind's change overtakes nothing here.
  const other = store.read("k", policy({ freshMs: 0 }));
  store.supersede("comments");
  answer(2, json("newer"));
  expect(answered(await other).body).toBe("newer");
});

it("supersede in a scope overtakes only that scope's reads", async () => {
  const { transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const a = store.read("a", policy(), { scope: "1" });
  const b = store.read("b", policy(), { scope: "2" });
  store.supersede("catalog", "1");
  answer(0, json("a"));
  answer(1, json("b"));
  expect("superseded" in (await a)).toBe(true);
  expect(answered(await b).body).toBe("b");
});

it("stale: the next reader reads, but a read in flight still serves those who join it", async () => {
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const first = store.read("k", policy());
  answer(0, json(1));
  await first;
  store.stale("catalog");
  const second = store.read("k", policy());
  store.stale("catalog");
  const joined = store.read("k", policy());
  expect(calls).toHaveLength(2);
  answer(1, json(2));
  expect(await joined).toBe(await second);
  // Answered after the mark: fresh again.
  await store.read("k", policy());
  expect(calls).toHaveLength(2);
});

it("standing: answers given before the service's publication count are stale, a later one is not", async () => {
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const first = store.read("k", policy());
  answer(0, json(1, { "x-archer-event-seq": "4" }));
  expect(answered(await first).seq).toBe(4);
  store.standing(4);
  await store.read("k", policy());
  expect(calls).toHaveLength(1);
  store.standing(5);
  const second = store.read("k", policy());
  expect(calls).toHaveLength(2);
  // One still answered below the count it now knows is stale on arrival.
  answer(1, json(2, { "x-archer-event-seq": "3" }));
  await second;
  const third = store.read("k", policy());
  expect(calls).toHaveLength(3);
  answer(2, json(3, { "x-archer-event-seq": "6" }));
  await third;
  await store.read("k", policy());
  expect(calls).toHaveLength(3);
});

it("a conditional read sends the held ETag; a 304 is the held answer, the same object", async () => {
  clock();
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const conditional = policy({ conditional: true });
  const first = store.read("k", conditional);
  expect(header(calls[0], "if-none-match")).toBeNull();
  answer(0, json({ big: true }, { etag: 'W/"1"' }));
  const a = await first;
  now += 5000;
  const second = store.read("k", conditional);
  expect(header(calls[1], "if-none-match")).toBe('W/"1"');
  answer(1, new Response(null, { status: 304, headers: { etag: 'W/"1"' } }));
  expect(await second).toBe(a);
  // And it counts as answered now.
  await store.read("k", conditional);
  expect(calls).toHaveLength(2);
  // A policy that is not conditional sends none.
  now += 5000;
  void store.read("k", policy());
  expect(header(calls[2], "if-none-match")).toBeNull();
});

it("an answer with the held text keeps the held body, unparsed; another text is parsed anew", async () => {
  clock();
  const { transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const parse = vi.fn((raw: unknown) => ({ ...(raw as object) }));
  const first = store.read("k", policy({ parse }));
  answer(0, json({ v: 1 }, { etag: "a" }));
  const a = answered(await first);
  now += 5000;
  const second = store.read("k", policy({ parse }));
  answer(1, json({ v: 1 }, { etag: "b" }));
  const b = answered(await second);
  expect(b.body).toBe(a.body);
  expect(b.etag).toBe("b");
  expect(parse).toHaveBeenCalledTimes(1);
  now += 5000;
  const third = store.read("k", policy({ parse }));
  answer(2, json({ v: 2 }));
  expect(answered(await third).body).toEqual({ v: 2 });
  expect(parse).toHaveBeenCalledTimes(2);
});

it("a fetcher that can only give JSON is read by its serialisation", async () => {
  const store = createResourceStore(
    async () => ({ ok: true, json: async () => ({ only: "json" }) }) as unknown as Response,
    limits,
  );
  expect(answered(await store.read("k", policy())).body).toEqual({ only: "json" });
});

it("replace: the held body changes at once, unannounced; the next read is a full one", async () => {
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const heard: unknown[] = [];
  store.subscribe("k", (a) => heard.push(a.body));
  const conditional = policy<{ v: number }>({ conditional: true });
  const first = store.read("k", conditional);
  answer(0, json({ v: 1 }, { etag: "e" }));
  await first;
  store.replace<{ v: number }>("k", (held) => ({ v: held.v + 10 }));
  expect(store.peek("k")?.body).toEqual({ v: 11 });
  expect(heard).toEqual([{ v: 1 }]);
  const next = store.read("k", conditional);
  expect(calls).toHaveLength(2);
  expect(header(calls[1], "if-none-match")).toBeNull();
  // The same text as before the edit is no reason to keep the edited body.
  answer(1, json({ v: 1 }));
  expect(answered(await next).body).toEqual({ v: 1 });
});

it("revision: a reader that knows a revision takes a held or joined answer only at it, else reads once more", async () => {
  clock();
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  const revisioned = policy<{ revision: string }>({ revision: (body) => body.revision });
  const [a, b] = [store.read("d", revisioned, { revision: "r1" }), store.read("d", revisioned, { revision: "r1" })];
  answer(0, json({ revision: "r1" }));
  expect(await b).toBe(await a);
  await store.read("d", revisioned, { revision: "r1" });
  expect(calls).toHaveLength(1);
  // Held at r1, the reader knows r2: read.
  const r2 = store.read("d", revisioned, { revision: "r2" });
  expect(calls).toHaveLength(2);
  answer(1, json({ revision: "r2" }));
  expect(answered(await r2).body.revision).toBe("r2");
  // A reader that knows no revision takes what is held.
  expect(answered(await store.read("d", revisioned)).body.revision).toBe("r2");
  expect(calls).toHaveLength(2);
  // Joined in flight, answered at an older revision than the joiner knows: once more.
  const first = store.read("e", revisioned);
  const joined = store.read("e", revisioned, { revision: "r4" });
  answer(2, json({ revision: "r3" }));
  expect(answered(await first).body.revision).toBe("r3");
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  expect(calls).toHaveLength(4);
  answer(3, json({ revision: "r4" }));
  expect(answered(await joined).body.revision).toBe("r4");
});

it("take: the held answer is handed over once; flight joins a read without starting one", async () => {
  const { calls, transport, answer } = service();
  const store = createResourceStore(transport, limits);
  expect(store.flight("k")).toBeUndefined();
  const read = store.read("k", policy());
  const joined = store.flight("k");
  expect(joined).toBeDefined();
  answer(0, json("v", { etag: "t", "x-archer-event-seq": "9" }));
  expect(await joined).toBe(await read);
  expect(store.take("k")).toMatchObject({ body: "v", etag: "t", seq: 9 });
  expect(store.take("k")).toBeUndefined();
  expect(store.flight("k")).toBeUndefined();
  expect(calls).toHaveLength(1);
});

it("holds at most maxEntries settled entries, the least recently used dropped first", async () => {
  const fetched: string[] = [];
  const counted = createResourceStore(
    async (url) => {
      fetched.push(url);
      return json("v");
    },
    { maxEntries: 4, maxBytes: 1 << 20 },
  );
  const long = policy({ freshMs: 60_000 });
  for (const key of ["a", "b", "c", "d", "e", "f"]) await counted.read(key, long);
  expect(counted.peek("a")).toBeUndefined();
  expect(counted.peek("b")).toBeUndefined();
  expect(counted.peek("c")).toBeDefined();
  // A hit counts as use: c outlives d.
  await counted.read("c", long);
  await counted.read("g", long);
  expect(counted.peek("c")).toBeDefined();
  expect(counted.peek("d")).toBeUndefined();
  expect(fetched).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
});

it("bounds the held text in bytes too, but never drops a read in flight, a listened-to entry or the newest", async () => {
  const { transport, answer } = service();
  const store = createResourceStore(transport, { maxEntries: 64, maxBytes: 10 });
  const long = policy({ freshMs: 60_000 });
  store.subscribe("watched", () => {});
  const watched = store.read("watched", long);
  answer(0, json("123456"));
  await watched;
  const slow = store.read("slow", long);
  const big = store.read("big", long);
  answer(2, json("1234567890123"));
  await big;
  // Over the bound, yet each kept: the newest, the listened-to one, the one in flight.
  expect(store.peek("big")).toBeDefined();
  expect(store.peek("watched")).toBeDefined();
  const other = store.read("other", long);
  answer(3, json("1"));
  await other;
  expect(store.peek("big")).toBeUndefined();
  expect(store.peek("watched")).toBeDefined();
  answer(1, json("s"));
  expect(answered(await slow).body).toBe("s");
});

it("forget drops every entry, or those under a prefix", async () => {
  const store = createResourceStore(async () => json("v"), limits);
  await store.read("p:1", policy());
  await store.read("p:2", policy());
  await store.read("q:1", policy());
  store.forget("p:");
  expect(store.peek("p:1")).toBeUndefined();
  expect(store.peek("q:1")).toBeDefined();
  store.forget();
  expect(store.peek("q:1")).toBeUndefined();
});

it("a reader's own fetch and URL serve a key that is not the URL", async () => {
  const own = vi.fn(async () => json("mine"));
  const store = createResourceStore(async () => json("store"), limits);
  expect(answered(await store.read("name", policy(), { fetch: own, url: "api/x" })).body).toBe("mine");
  expect(own).toHaveBeenCalledWith("api/x", expect.objectContaining({ cache: "no-store" }));
});

it("a read its starter gives up on (a stalled body) ends for its joiners too, and the next reader asks again", async () => {
  let calls = 0;
  const store = createResourceStore(async () => {
    calls++;
    return calls === 1
      ? ({ ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response)
      : json("fresh");
  }, limits);
  const controller = new AbortController();
  const stalled = store.read("k", policy(), { signal: controller.signal });
  const joined = store.read("k", policy());
  await Promise.resolve();
  controller.abort(new Error("deadline"));
  await expect(stalled).rejects.toThrow("deadline");
  await expect(joined).rejects.toThrow("deadline");
  expect(store.flight("k")).toBeUndefined();
  expect(answered(await store.read("k", policy())).body).toBe("fresh");
  expect(calls).toBe(2);
});
