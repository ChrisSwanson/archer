// surfaces.mjs recipes against the Pageturner fixtures (round 1, re-score 4): stale, walkthrough (desktop and phone
// sheet), highlights already shown, the bell with an unread count, and the 0.7.2 "Graph tools" launcher name.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { STATES, openState } from "../harness/surfaces.mjs";

const READY = '<div class="react-flow__node">Node</div>';
let pages = {};
let server, origin, browser;
before(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(pages[new URL(req.url, "http://x").pathname] ?? "<p>none</p>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});
const state = (id) => STATES.find((s) => s.id === id);
async function open(id, html, path, { viewport } = {}) {
  pages = { [path]: html };
  const page = await browser.newPage(viewport ? { viewport } : {});
  try {
    const r = await openState(page, state(id), { origin, slug: "pageturner" });
    return { r, clicks: await page.evaluate(() => window.clicks ?? []), page };
  } finally {
    await page.close();
  }
}
const C = "/projects/pageturner/diagrams/containers.mmd";
const log = `<script>window.clicks=[];document.addEventListener('click',e=>{const b=e.target.closest('button');if(b)clicks.push(b.getAttribute('aria-label')||b.textContent.trim())},true)</script>`;

test("P7.notifications finds the bell when its name carries an unread count", async () => {
  const { r, clicks } = await open(
    "P7.notifications",
    `${log}<button aria-label="Notifications, 1 unread agent answer">1</button>`,
    "/projects/pageturner/",
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clicks, ["Notifications, 1 unread agent answer"]);
});

test("P4.highlights leaves an already shown Highlights view alone (clicking would turn it off)", async () => {
  const { r, clicks } = await open(
    "P4.highlights",
    `${log}${READY}<button aria-pressed="true">Highlights · 1</button><button>Members</button>`,
    C,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clicks, []);
});

test("P4.highlights opens the phone sheet when Members is hidden", async () => {
  const html = `${log}${READY}<button onclick="m.hidden=false">Highlights</button><button id="m" hidden>Members</button>`;
  const { r, clicks } = await open("P4.highlights", html, C);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clicks, ["Highlights"]);
});

const tools = (
  accuracy,
  launcher = "Export, compare and more",
) => `${log}${READY}<button aria-label="${launcher}" onclick="g.hidden=false">t</button>
  <div id="g" hidden><button onclick="p.hidden=false">Check diagram accuracy</button><button onclick="cmp.hidden=false">Compare revisions</button></div>
  <section id="p" hidden><button onclick="s.hidden=false">Check covered files</button><p id="s" role="status" hidden>${accuracy}</p></section><div id="cmp" class="accuracy-header" hidden>cmp</div>`;

test("P4.stale checks accuracy through the canvas tools and needs a stale status", async () => {
  const stale = await open("P4.stale", tools("Covered files changed since the last diagram commit."), C);
  assert.equal(stale.r.ok, true, JSON.stringify(stale.r));
  assert.deepEqual(stale.clicks, ["Export, compare and more", "Check diagram accuracy", "Check covered files"]);
  const current = await open("P4.stale", tools("Covered files match the last diagram commit."), C);
  assert.match(current.r.notAvailable ?? "", /not stale/);
});

test('P11.compare still opens on the 0.7.2 launcher name "Graph tools"', async () => {
  const { r, clicks } = await open(
    "P11.compare",
    tools("", "Graph tools"),
    "/projects/pageturner/diagrams/fulfilment.mmd",
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(clicks, ["Graph tools", "Compare revisions"]);
});

const walk = (
  phone,
) => `${log}${READY}${phone ? '<button onclick="w.hidden=false">Highlights</button>' : ""}<button id="w" ${phone ? "hidden" : ""} onclick="c.hidden=false">Walkthroughs · 1</button>
  <div id="c" role="group" aria-label="Walkthroughs on this diagram" hidden><button onclick="k.hidden=false">Checkout from basket to dispatch</button></div><div id="k" class="archer-walk" hidden>Step 1 of 5</div>`;
for (const phone of [false, true])
  test(`P4.walkthrough opens containers' first tour at step 1${phone ? " through the phone sheet" : ""}`, async () => {
    const { r, clicks } = await open("P4.walkthrough", walk(phone), C);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(clicks, [
      ...(phone ? ["Highlights"] : []),
      "Walkthroughs · 1",
      "Checkout from basket to dispatch",
    ]);
  });
