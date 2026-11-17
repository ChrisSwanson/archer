// After pairing, the browser lands where it was going (decided 2026-11-02; user-flows claude-09): the page it was
// refused at reaches the pairing form as a same-origin referrer (the refused page stays script-free and the same
// bytes everywhere), the form sends it as `return`, and `/-/pair` answers its one 303 there. The return is
// attacker-influenced input: only a clean page path of this instance qualifies, never a credential, never another
// host, and a project that is not attached lands on `/projects/` as before.
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, test } from "vitest";
import { safeReturnPath, MAX_RETURN_CHARS } from "../../src/service/return-path.ts";
import { PAIRING_PAGE } from "../../src/service/pairing-page.ts";
import { connectService } from "../../src/service/service-client.ts";
import { cleanUp, http, project, service } from "./support.ts";

afterEach(cleanUp);

describe("safeReturnPath", () => {
  test("takes a clean page path of the instance, with its query", () => {
    for (const ok of [
      "/projects/shop/",
      "/projects/shop/diagrams/flow.mmd",
      "/projects/shop/notes/a%20b.md",
      "/projects/shop/diagrams/flow.mmd?walkthrough=ask&step=2",
      "/projects/shop/?follow",
      "/projects/shop/diagrams/flow.mmd?edit",
      "/projects/shop/diagrams/?q=checkout",
      "/projects/",
      "/projects/shop/-/repo/README.md",
    ])
      expect(safeReturnPath(ok), ok).toBe(ok);
  });

  test("refuses anything that could leave the instance, change its meaning, or carry a credential", () => {
    for (const bad of [
      undefined,
      null,
      1,
      {},
      "",
      "projects/shop/",
      "https://evil.example/",
      "http://127.0.0.1:1/projects/shop/",
      "//evil.example/projects/shop/",
      "///evil.example/",
      "/\\evil.example/",
      "/projects/shop/\\x",
      "\\\\evil.example",
      "/projects\\shop/",
      "javascript:alert(1)",
      "/%2F%2Fevil.example/",
      "/projects/%2F%2Fevil.example/",
      "/projects/shop/%5c..%5c",
      "/projects/shop/a%5Cb",
      "/projects/shop/../../etc/passwd",
      "/projects/shop/%2e%2e/x",
      "/projects/shop/.%2E/x",
      "/projects/shop/./x",
      "/projects/shop//evil.example",
      "/projects/shop/x\n",
      "/projects/shop/x y",
      "/projects/shop/ä.md",
      "/projects/shop/x\u0000",
      "/projects/shop/x#name",
      "/projects/shop/x?token=abc",
      "/projects/shop/x?%74oken=abc",
      "/projects/shop/x?Token=abc",
      "/projects/shop/x?grant=1",
      "/projects/shop/x?code=7KQ4-M2XD",
      "/projects/shop/x?a=1&access_token=2",
      `/${"ab".repeat(32)}/projects/shop/`,
      "/p/shop/views/flow/",
      "/-/pair",
      "/api/projects",
      "/",
      "/projects/Shop/",
      "/projects/shop/-/x",
      "/projects/shop/x?",
      `/projects/shop/${"a".repeat(MAX_RETURN_CHARS)}`,
      "/projects/shop/<script>",
    ])
      expect(safeReturnPath(bad), JSON.stringify(bad)).toBeNull();
  });

  // R6 call-site review of `new URL(raw, BASE)` (security, 2026-11-03, O154): every bypass shape, by family.
  const refuses = (family: string, inputs: readonly string[]) =>
    test(`refuses ${family}`, () => {
      for (const bad of inputs) expect(safeReturnPath(bad), JSON.stringify(bad)).toBeNull();
    });
  refuses("another scheme or authority, in any spelling", [
    "http:/projects/shop/",
    "http:projects/shop/",
    "HTTPS://evil.example/projects/shop/",
    "data:text/html,x",
    "file:///etc/passwd",
    "vbscript:x",
    "/projects/shop/x:y",
    "/projects/shop:80/",
    "/projects/shop/C:%5Cx",
    "/projects/shop/javascript:x",
    "//evil.example",
    "/\\/evil.example/",
    "\\/evil.example/",
    "/projects//evil.example/",
    "/projects/\\evil",
    "/projects/shop/\\\\evil",
  ]);
  refuses("userinfo and host-like segments that could become an authority", [
    "//user:pass@evil.example/projects/shop/",
    "/projects/shop/user:pass@evil/",
    "/projects/user@evil.example/",
    "/projects/shop@evil/",
    "/projects/evil.example/",
    "/projects/shop./",
    "/projects/[::1]/",
    "/projects/127.0.0.1/",
  ]);
  refuses("encoded separators and backslashes", [
    "/projects/shop%2F..%2F..%2Fx",
    "/projects/shop%2F/",
    "/projects/shop/x%2f..%2f..",
    "/projects/shop/x%2Fy",
    "/projects/shop/%5C%5Cevil",
    "/projects/shop/x%5c",
    "/%2f/evil.example",
    "/%5c/evil.example",
    "/projects/%2F%2Fevil.example/",
  ]);
  refuses("dot segments in every spelling, in the slug, a folder or the system route", [
    "/projects/../x",
    "/projects/%2e%2e/",
    "/projects/%2E./",
    "/projects/.%2e",
    "/projects/.",
    "/projects/shop/..",
    "/projects/shop/%2e",
    "/projects/shop/.%2e/.%2e/x",
    "/projects/shop/-/repo/../x",
    "/projects/shop/-/repo/%2e%2e/x",
    "/projects/shop/x/./y",
    "/projects/shop/x/%2E/y",
  ]);
  refuses("controls, whitespace and Unicode the URL parser would strip or rewrite", [
    "/projects/shop/x\t",
    "\t/projects/shop/",
    " /projects/shop/",
    "/projects/shop/ ",
    "/projects/shop/x\r",
    "\n/projects/shop/",
    "/projects/shop/x ",
    "/projects/shop/ｘ",
    "/projects/ｓhop/",
    "／／evil.example",
    "/projects/shop/ ",
    "/projects/shop/x%00",
    "/projects/shop/x%0d%0aSet-Cookie:a=b",
    "/projects/shop/x%0A",
    "/projects/shop/x%7F",
    "/projects/shop/x%09",
  ]);
  refuses("malformed or overlong percent-encoding", [
    "/projects/shop/%",
    "/projects/shop/%zz",
    "/projects/shop/%C0%AF",
    "/projects/shop/%C0%AE%C0%AE/x",
    "/projects/shop/%ff",
  ]);
  refuses("a slug outside the grammar", [
    "/projects/SHOP/",
    "/projects/-shop/",
    "/projects/sh%6Fp/",
    "/projects/sh_op/",
    "/projects/shop%20/",
    "/projects//",
  ]);
  refuses("a credential in the query, however the key is spelled", [
    "/projects/shop/x?to%6Ben=1",
    "/projects/shop/x?TOK%45N=1",
    "/projects/shop/x?+token=1",
    "/projects/shop/x?token%00=1",
    "/projects/shop/x?&token=1",
    "/projects/shop/x?a&token",
    "/projects/shop/x?a%3Dtoken=1",
    "/projects/shop/x?session_id=1",
    "/projects/shop/x?api_key=1",
    "/projects/shop/x?auth=1",
    "/projects/shop/x?Authorization=1",
    "/projects/shop/x?sig=1",
    "/projects/shop/x?signature=1",
    "/projects/shop/x?pairing=1",
    "/projects/shop/x?passwd=1",
    "/projects/shop/?follow&token=1",
    "/projects/?grant=1",
  ]);
  refuses("a fragment or anything after it", ["/projects/shop/x#", "/projects/shop/x?a=1#b", "/projects/shop/x%23y#z"]);

  test("what it accepts stays a path of this page's grammar: encoded text is a filename, a query value is only a value", () => {
    // Each is one filename or query value under an attached project; a direct link could name the same address.
    for (const ok of [
      "/projects/shop/@evil.example",
      "/projects/shop/%252e%252e/x",
      "/projects/shop/%EF%BC%8F%EF%BC%8Fevil",
      "/projects/shop/x%23y",
      "/projects/shop/x%3Fy",
      "/projects/shop/x?next=//evil.example",
      "/projects/shop/x?a=%0d%0aSet-Cookie:a=b",
      "/projects/shop/x?a=1%26token%3D2",
      "/projects/shop/x?a=1;token=abc",
      "/projects/shop/-/edit/",
    ]) {
      expect(safeReturnPath(ok), ok).toBe(ok);
      // Whatever origin a browser resolves the Location against, it stays there, under /projects/, and spelled the same.
      const at = new URL(ok, "https://archer.example:4443/-/pair");
      expect(at.origin, ok).toBe("https://archer.example:4443");
      expect(at.pathname + at.search, ok).toBe(ok);
      expect(
        [...at.searchParams.keys()].some((key) => /token|grant/i.test(key)),
        ok,
      ).toBe(false);
    }
  });

  test("generated inputs: anything accepted resolves to this origin under /projects/, unchanged and credential-free", () => {
    // Deterministic: every 4-piece join of tricky fragments after the prefix (and without it).
    const pieces = [
      "/",
      "\\",
      ".",
      "..",
      "%2e",
      "%2f",
      "%5c",
      "@",
      ":",
      "?",
      "#",
      "&",
      "=",
      "token",
      "%74oken",
      "shop",
      "x.md",
      "//",
      "%00",
      "%25",
      ";",
      "-",
      " ",
      "\t",
    ];
    let accepted = 0;
    for (const lead of ["/projects/", "/projects/shop/", "", "/"])
      for (const a of pieces)
        for (const b of pieces)
          for (const c of pieces) {
            const raw = lead + a + b + c;
            const path = safeReturnPath(raw);
            if (path === null) continue;
            accepted += 1;
            expect(path).toBe(raw);
            const at = new URL(path, "https://archer.example/-/pair");
            expect(at.origin, raw).toBe("https://archer.example");
            expect(at.pathname.startsWith("/projects/"), raw).toBe(true);
            expect(at.pathname + at.search, raw).toBe(raw);
            expect(at.hash, raw).toBe("");
            expect(
              [...at.searchParams.keys()].some((key) => /token/i.test(key)),
              raw,
            ).toBe(false);
          }
    expect(accepted).toBeGreaterThan(100);
  });
});

/** Runs the pairing page's inline script against a stub DOM, location and referrer; returns the return field. */
function formReturn(href: string, referrer: string, storage: Map<string, string>) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(PAIRING_PAGE.toString())?.[1];
  if (script === undefined) throw new Error("the pairing page has no inline script");
  const element = (id: string) => ({
    id,
    value: "",
    disabled: id === "return",
    textContent: "",
    setAttribute() {},
    addEventListener() {},
    focus() {},
    querySelector: () => ({ disabled: false }),
  });
  const elements = Object.fromEntries(["pair", "code", "error", "return"].map((id) => [id, element(id)]));
  const url = new URL(href);
  runInNewContext(script, {
    document: { getElementById: (id: string) => elements[id] ?? null, referrer },
    location: { pathname: url.pathname, search: url.search, origin: url.origin, href: url.href },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    addEventListener() {},
    setTimeout() {},
    URL,
    URLSearchParams,
  });
  const { value, disabled } = elements["return"]!;
  return { value, disabled };
}

describe("the pairing form carries the page the browser was refused at", () => {
  test("from the refused page's same-origin referrer, kept for a retry after a wrong code", () => {
    const storage = new Map<string, string>();
    const at = "/projects/shop/diagrams/flow.mmd?walkthrough=ask&step=2";
    expect(formReturn("http://h:1/", `http://h:1${at}`, storage)).toEqual({ value: at, disabled: false });
    // The refused-code answer is the same page at /-/pair (its referrer is `/`): the return comes from this tab.
    expect(formReturn("http://h:1/-/pair", "http://h:1/", storage)).toEqual({ value: at, disabled: false });
    // Opened another way, nothing is kept or sent.
    expect(formReturn("http://h:1/", "", storage)).toEqual({ value: "", disabled: true });
    expect(storage.size).toBe(0);
  });

  test("never from another origin, never a credential, never more than the body cap holds", () => {
    expect(formReturn("http://h:1/", "http://evil.example/projects/shop/x.md", new Map())).toEqual({
      value: "",
      disabled: true,
    });
    expect(formReturn("http://h:1/", "http://h:2/projects/shop/x.md", new Map())).toEqual({
      value: "",
      disabled: true,
    });
    expect(formReturn("http://h:1/", "http://h:1/p/shop/views/x/", new Map())).toEqual({ value: "", disabled: true });
    // A query naming a credential is left out; the path alone is sent.
    expect(formReturn("http://h:1/", `http://h:1/projects/shop/x.md?token=${"0".repeat(32)}`, new Map())).toEqual({
      value: "/projects/shop/x.md",
      disabled: false,
    });
    expect(formReturn("http://h:1/", "http://h:1/projects/shop/x.md?a=1&Grant=2", new Map())).toEqual({
      value: "/projects/shop/x.md",
      disabled: false,
    });
    // Too long for /-/pair's body cap with a code: not sent, so the pairing itself still works.
    expect(formReturn("http://h:1/", `http://h:1/projects/shop/${"a".repeat(300)}.md`, new Map())).toEqual({
      value: "",
      disabled: true,
    });
  });
});

const json = (origin: string) => ({ origin, "content-type": "application/json" });

test("a correct code with a safe return answers its one 303 there; any other return lands on /projects/", async () => {
  const root = project();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const attached = await client.call("attach", { root });
    const slug = new URL(attached.url).pathname.split("/")[2]!;
    const origin = new URL(svc.homeUrl).origin;
    // The refused page (no script, the same bytes everywhere) lets its link send its address to the form, same origin only.
    const refused = await http(`${origin}/projects/${slug}/diagrams/flow.mmd`);
    expect(refused.status).toBe(404);
    expect(refused.headers["referrer-policy"]).toBe("same-origin");
    expect(refused.body).toContain('<a href="/">Enter it here</a>');
    expect(refused.body).not.toContain("<script");

    const target = `/projects/${slug}/diagrams/flow.mmd?walkthrough=ask&step=2`;
    const form = async (ret: string) => {
      const { code } = await client.call("issuePairingCode", {});
      return http(`${origin}/-/pair`, {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, return: ret }).toString(),
      });
    };
    const viaJson = async (ret: unknown) => {
      const { code } = await client.call("issuePairingCode", {});
      return http(`${origin}/-/pair`, {
        method: "POST",
        headers: json(origin),
        body: JSON.stringify({ code, return: ret }),
      });
    };
    const formed = await form(target);
    expect(formed.status, formed.body).toBe(303);
    expect(formed.headers.location).toBe(target);
    expect(formed.headers["set-cookie"]).toBeDefined();
    expect((await viaJson(`/projects/${slug}/`)).headers.location).toBe(`/projects/${slug}/`);
    for (const ret of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example",
      "/%2F%2Fevil.example/",
      `/projects/${slug}/%2e%2e/%2e%2e/x`,
      `/projects/${slug}/x?token=${svc.token}`,
      "/projects/not-attached/diagrams/flow.mmd",
      "/p/x/views/y/",
      7,
    ]) {
      const answer = typeof ret === "string" ? await form(ret) : await viaJson(ret);
      expect(answer.status, String(ret)).toBe(303);
      expect(answer.headers.location, String(ret)).toBe("/projects/");
    }
    // A wrong code with a return is refused as before, and the return goes nowhere.
    const wrong = await http(`${origin}/-/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: "0000-0000", return: target }).toString(),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.headers.location).toBeUndefined();
    expect(wrong.body).not.toContain(target);
    // Two returns, or a return with no code, are not a pairing.
    const { code } = await client.call("issuePairingCode", {});
    const twice = await http(`${origin}/-/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: `code=${code}&return=%2Fprojects%2F&return=%2Fprojects%2F`,
    });
    expect(twice.status).toBe(400);
  } finally {
    client.close();
  }
}, 30_000);

test("a link to a page signs in and lands on that page, its query kept and its token gone", async () => {
  const root = project();
  const { svc } = await service();
  const client = await connectService(svc.socketPath);
  try {
    const attached = await client.call("attach", { root });
    const slug = new URL(attached.url).pathname.split("/")[2]!;
    const origin = new URL(svc.homeUrl).origin;
    const issued = await client.call("issueAccess", { label: "deep link" });
    const answer = await http(`${origin}/projects/${slug}/?walkthrough=ask&token=${issued.token}&step=2`);
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe(`/projects/${slug}/?walkthrough=ask&step=2`);
  } finally {
    client.close();
  }
}, 20_000);
