#!/usr/bin/env node
// Records the README demo from the REAL app (not the landing film): the landing film's shop story re-enacted in a
// devkit sandbox, in the light and the dark theme, as animated WebP (inline on GitHub), MP4 (to link) and a poster.
//
//   npm run build                                   # the sandbox serves ui/dist/index.html
//   node tools/devkit/journeys/readme-demo.mjs [--out docs/media] [--theme light|dark|both] [--width 1360] [--fps 20] [--webp lossless|mixed|lossy]
//        [--shots <dir>]   also keep a screenshot at every beat (for checking the run)
//        [--no-encode]     drive and screenshot only; write no media
//
// Not a harness journey (smoke.mjs would add tracing and probes to every frame): a plain script. Per theme it starts a
// fresh sandbox `readme-demo` (tools/devkit/sandbox.mjs `up`, a copy of a `shop` corpus written from
// site/diagrams/shop-*.mmd) and takes it `down` at the end. The agent's side is `archer call` against that sandbox
// (harness/agent.mjs: the sandbox's own state dir, socket and home), never the user's service.
//
// The story (site/.vitepress/theme/landing-film.mts): a note embedding the proposal flowchart with a saved walkthrough,
// played step by step; a comment on Payment Worker → Payment Provider; the agent replies, redraws the diagram and
// highlights what it changed; then the sequence diagram with the agent's highlights.
//
// Headless Chromium paints no mouse pointer, so the page gets a drawn arrow that follows the real mouse events
// (pointer-events: none); everything else on screen is the app. Needs ffmpeg and img2webp on PATH; frames are
// assembled at the times Chromium painted them.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { REPO, down, readRecord, up } from "../sandbox.mjs";
import { createAgent } from "../harness/agent.mjs";

const { values: opt } = parseArgs({
  options: {
    out: { type: "string", default: join(REPO, "docs/media") },
    theme: { type: "string", default: "both" },
    width: { type: "string", default: "1360" }, // the viewport's own width: no resampling
    webp: { type: "string", default: "lossless" }, // lossy blurs and rings the UI's high-contrast edges
    fps: { type: "string", default: "20" },
    shots: { type: "string" },
    "no-encode": { type: "boolean", default: false },
  },
});
const NAME = "readme-demo";
const VIEWPORT = { width: 1360, height: 860 };
const NOTE = "notes/proposals/payment-worker.md";
const VIEW = `${NOTE}#proposal`;
const SEQUENCE = "checkout-sequence";
const COMMENT = "If the worker crashes after the charge, is the card charged twice?";
const REPLY = "Not with an idempotency key. I added one, and a dead-letter queue after 3 failed tries.";
const diagram = (name) => readFileSync(join(REPO, "site/diagrams", `${name}.mmd`), "utf8");

/** The `shop` project: a note with the proposal flowchart embedded, and the sequence diagram as a view. */
function writeCorpus(dir) {
  const shop = join(dir, "shop");
  mkdirSync(join(shop, ".archer/notes/proposals"), { recursive: true });
  mkdirSync(join(shop, ".archer/diagrams"), { recursive: true });
  writeFileSync(
    join(shop, "archer.toml"),
    [
      "version = 1",
      'name = "Shop"',
      'folder = ".archer"',
      "",
      "[[views]]",
      `id = "${SEQUENCE}"`,
      'kind = "sequence"',
      'title = "Checkout, in Order"',
      `source = ".archer/diagrams/${SEQUENCE}.mmd"`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(shop, ".archer", NOTE),
    [
      "---",
      "description: Move card capture out of the checkout request.",
      "---",
      "# Payment Worker",
      "",
      "Checkout charges the card inside the request today, so a slow provider holds the shopper's page open. This",
      "proposal moves the charge to a worker behind a job queue: the API saves the order, queues a capture job and",
      "answers at once.",
      "",
      "```mermaid",
      "%% archer-id: proposal",
      diagram("shop-proposal").trimEnd(),
      "```",
      "",
      "## Open questions",
      "",
      "- How many retries before giving up.",
      "- What the shopper sees while the charge is pending.",
      "",
    ].join("\n"),
  );
  writeFileSync(join(shop, `.archer/diagrams/${SEQUENCE}.mmd`), diagram("shop-sequence"));
}

/** The agent's setup before the recording: the saved walkthrough on the proposal (landing-film.mts WALKS.proposal). */
async function seed(agent) {
  const read = await agent("read_diagram", { viewId: VIEW });
  await agent("write_walkthrough", {
    viewId: VIEW,
    modelRevision: read.modelRevision,
    walkthrough: {
      id: "payment-capture",
      title: "How a Payment Is Captured",
      open: ["boundary"],
      steps: [
        {
          title: "The order is saved",
          kind: "sends",
          what: "The Orders API saves the order before anything else.",
          nodes: [{ id: "api" }, { id: "db" }],
          edges: [{ id: "save" }],
        },
        {
          title: "The API hands off a capture job",
          kind: "sends",
          what: "It queues a capture job and answers the shopper at once.",
          nodes: [{ id: "api" }, { id: "queue" }, { id: "worker" }],
          edges: [{ id: "enqueue" }, { id: "take" }],
        },
        {
          title: "The worker charges the card",
          kind: "sends",
          what: "The worker takes the job and charges the card with the provider.",
          nodes: [{ id: "worker" }, { id: "provider" }],
          edges: [{ id: "charge" }],
        },
      ],
    },
  });
}

/** A drawn pointer that follows the page's own mouse events (headless Chromium paints none). */
const POINTER = () => {
  const install = () => {
    if (document.getElementById("demo-pointer") || !document.body) return;
    const el = document.createElement("div");
    el.id = "demo-pointer";
    el.innerHTML =
      '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.5 15 L17 15 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(el.style, {
      position: "fixed",
      left: "0",
      top: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      transform: "translate(-100px,-100px)",
      transition: "scale 120ms",
      transformOrigin: "2px 2px",
    });
    document.body.appendChild(el);
    const at = { x: -100, y: -100 };
    addEventListener(
      "mousemove",
      (e) => {
        at.x = e.clientX;
        at.y = e.clientY;
        el.style.transform = `translate(${at.x - 2}px,${at.y - 2}px)`;
      },
      true,
    );
    addEventListener("mousedown", () => (el.style.scale = "0.82"), true);
    addEventListener("mouseup", () => (el.style.scale = "1"), true);
    const last = sessionStorage.getItem("demo-pointer");
    if (last) {
      const [x, y] = JSON.parse(last);
      el.style.transform = `translate(${x - 2}px,${y - 2}px)`;
    }
    addEventListener("pagehide", () => sessionStorage.setItem("demo-pointer", JSON.stringify([at.x, at.y])));
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", install);
  else install();
};

function director(page) {
  let at = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const glide = async (x, y) => {
    const dist = Math.hypot(x - at.x, y - at.y);
    const n = Math.max(10, Math.min(40, Math.round(dist / 14)));
    const from = at;
    for (let i = 1; i <= n; i++) {
      const t = ease(i / n);
      await page.mouse.move(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
      await page.waitForTimeout(14);
    }
    at = { x, y };
  };
  const centre = async (locator) => {
    await locator.waitFor({ state: "visible" });
    const b = await locator.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  return {
    glide,
    park: async (x, y) => {
      at = { x, y };
      await page.mouse.move(x, y);
    },
    to: async (locator) => {
      const c = await centre(locator);
      await glide(c.x, c.y);
    },
    click: async (locator) => {
      const c = await centre(locator);
      await glide(c.x, c.y);
      await page.waitForTimeout(250);
      await page.mouse.down();
      await page.waitForTimeout(90);
      await page.mouse.up();
    },
    /** A point on an edge's drawn path that the edge itself is on top at (as harness actions.mjs selectEdgeNow). */
    edgePoint: async (id) => {
      const path = page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`).first();
      for (const f of [0.5, 0.35, 0.65, 0.25, 0.75]) {
        const pt = await path.evaluate((p, f) => {
          const m = p.getScreenCTM();
          const q = p.getPointAtLength(p.getTotalLength() * f);
          const x = q.x * m.a + q.y * m.c + m.e,
            y = q.x * m.b + q.y * m.d + m.f;
          const hit = document.elementFromPoint(x, y);
          return hit?.closest(".react-flow__edge")?.getAttribute("data-id") ===
            p.closest(".react-flow__edge").getAttribute("data-id")
            ? { x, y }
            : null;
        }, f);
        if (pt) return pt;
      }
      throw new Error(`no clickable point on edge ${id}`);
    },
    pause: (ms) => page.waitForTimeout(ms),
  };
}

async function run(theme) {
  const corpus = mkdtempSync(join(tmpdir(), "readme-demo-corpus-"));
  writeCorpus(corpus);
  if (readRecord(NAME)) await down({ name: NAME });
  const sandbox = await up({ name: NAME, corpus });
  const browser = await chromium.launch();
  try {
    const agent = createAgent({ sandbox });
    const call = (op, args) => agent(op, args, { project: "shop" });
    await seed(call);

    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: theme,
      reducedMotion: "no-preference",
    });
    await context.addInitScript(POINTER);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const login = await page.goto(sandbox.link);
    if (!login || login.status() >= 400) throw new Error(`login link answered ${login?.status()}`);
    const O = sandbox.origin.replace(/\/$/, "");
    await page.goto(`${O}/projects/shop/${NOTE}`);
    await page.getByRole("link", { name: "Open proposal, Flowchart" }).waitFor();
    await page.waitForTimeout(1200);
    const d = director(page);
    await d.park(VIEWPORT.width - 260, VIEWPORT.height - 120);

    const shots = opt.shots ? resolve(opt.shots, theme) : null;
    if (shots) mkdirSync(shots, { recursive: true });
    const shot = async (name) => shots && page.screenshot({ path: join(shots, `${name}.png`) });

    // Recording starts: Chromium sends a frame on every repaint, with its own timestamp.
    const session = await context.newCDPSession(page);
    const frames = [];
    session.on("Page.screencastFrame", (event) => {
      frames.push({ data: Buffer.from(event.data, "base64"), at: event.metadata.timestamp });
      session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    });
    const startCast = () =>
      session.send("Page.startScreencast", {
        format: "png",
        everyNthFrame: 1,
        maxWidth: VIEWPORT.width * 2,
        maxHeight: VIEWPORT.height * 2,
      });
    await startCast();
    // A navigation can stop the screencast; restart it on every new document.
    page.on("framenavigated", (f) => {
      if (f === page.mainFrame()) startCast().catch(() => {});
    });

    // 1. The note, then its diagram, and the saved walkthrough step by step.
    await d.pause(1000);
    await shot("01-note");
    const embed = page.getByRole("link", { name: "Open proposal, Flowchart" });
    await d.to(embed);
    await d.pause(500);
    await d.click(embed);
    await page.locator(".react-flow__node").first().waitFor();
    await d.pause(900);
    await shot("02-diagram");
    const start = page.getByRole("button", { name: /^How a Payment Is Captured\s*3 steps/ });
    await d.click(start);
    const steps = page.getByRole("group", { name: "Step controls" });
    await steps.getByText("Step 1 of 3").waitFor();
    await d.pause(1600);
    await shot("03-step1");
    const next = page.getByRole("button", { name: "Next step" });
    await d.click(next);
    await steps.getByText("Step 2 of 3").waitFor();
    posterAt = Date.now() / 1000 + 1.2;
    await d.pause(1600);
    await shot("04-step2");
    await d.click(next);
    await steps.getByText("Step 3 of 3").waitFor();
    await d.pause(1600);
    await shot("05-step3");
    await d.click(page.getByRole("button", { name: "Close walkthrough" }));
    await d.pause(700);
    // Leaving the walkthrough closes the boundary it opened; open it to reach the worker's own line.
    await d.click(page.getByRole("button", { name: "Open Proposed Boundary" }));
    await page.locator('.react-flow__node[data-id="worker"]').waitFor();
    await d.pause(900);

    // 2. Select Payment Worker → Payment Provider and comment on it.
    await d.click(page.getByRole("button", { name: "Select mode", exact: true }));
    await d.pause(400);
    const pt = await d.edgePoint("charge");
    await d.glide(pt.x, pt.y);
    await d.pause(300);
    await page.mouse.down();
    await d.pause(80);
    await page.mouse.up();
    await page.locator('.react-flow__edge.selected[data-id="charge"]').waitFor();
    await d.pause(900);
    await page.keyboard.press("c");
    const discussion = page.getByRole("region", { name: "Contextual discussion" });
    const box = discussion.getByRole("textbox", { name: "Comment" });
    await box.waitFor();
    await d.to(box);
    await d.pause(300);
    await box.pressSequentially(COMMENT, { delay: 16 });
    await d.pause(600);
    await shot("06-draft");
    await d.click(discussion.getByRole("button", { name: "Add comment" }));
    await discussion.getByText(COMMENT).waitFor();
    await d.to(discussion.getByText(COMMENT));
    await d.pause(1100);
    await shot("07-sent");

    // 3. The agent's next turn: it reads the comment, replies, redraws, and highlights what it changed.
    const got = await call("get_comments", { target: `view:${VIEW}` });
    const thread = got.threads.find((t) => t.comments.some((c) => c.body === COMMENT));
    if (!thread) throw new Error("get_comments has no thread with the comment");
    const read = await call("read_diagram", { viewId: VIEW });
    const wrote = await call("write_diagram", {
      viewId: VIEW,
      source: `%% archer-id: proposal\n${diagram("shop-revised")}`,
      expectedRevision: read.sourceRevision,
      summary: "Idempotency key on the charge; dead-letter queue after 3 tries",
    });
    await call("set_emphasis", {
      id: "what-i-changed",
      viewId: VIEW,
      title: "What I changed",
      groups: [
        { id: "added", style: "highlight", label: "Dead-letter queue", nodes: ["dlq"], edges: ["park"] },
        { id: "charge", style: "flow", label: "Charge, with key", nodes: [], edges: ["charge"] },
      ],
    });
    await call("reply_comment", { threadId: thread.id, body: REPLY, expectedRevision: thread.revision });
    await discussion.getByText(REPLY).waitFor({ timeout: 15_000 });
    await page.locator('.react-flow__node[data-id="dlq"]').waitFor({ timeout: 15_000 });
    await d.to(discussion.getByText(REPLY));
    await d.pause(2000);
    await shot("08-replied");
    void wrote;
    // Close the thread and see the whole redrawn diagram with the agent's highlights.
    await d.click(discussion.getByRole("button", { name: /^Close/ }).first());
    await d.pause(500);
    await d.click(page.getByRole("button", { name: "Fit view" }));
    await d.pause(1800);
    await shot("08b-revised");

    // 4. The same proposal as a sequence diagram, with the agent's highlights (landing-film.mts SEQUENCE_HIGHLIGHT).
    await call("set_emphasis", {
      id: "checkout-in-order",
      viewId: SEQUENCE,
      title: "Checkout, in Order",
      groups: [
        {
          id: "answered",
          style: "highlight",
          label: "Answered at once",
          description: "The API saves the order, queues the capture and answers.",
          nodes: [],
          edges: ["msg-0", "msg-1", "msg-2", "msg-3"],
        },
        {
          id: "charged",
          style: "flow",
          label: "Charged once",
          description: "The worker charges with the idempotency key.",
          nodes: [],
          edges: ["msg-4", "msg-5", "msg-6"],
        },
      ],
    });
    await page.keyboard.press("Escape");
    await page.goto(`${O}/projects/shop/diagrams/${SEQUENCE}.mmd`);
    await page.locator("g.archer-seq-participant").first().waitFor();
    await d.pause(600);
    await shot("09-sequence");
    const showAll = page.getByRole("button", { name: /Show all/ }).first();
    if (await showAll.isVisible()) {
      await d.click(showAll);
      await d.pause(600);
    }
    const legend = page.getByText("Charged once").first();
    await d.to(legend);
    await d.pause(3000);
    await shot("10-legend");

    await session.send("Page.stopScreencast");
    if (errors.length) console.warn(`${theme}: page errors:\n  ${errors.join("\n  ")}`);
    await context.close();
    posterAt -= frames[0]?.at ?? 0;
    return frames;
  } finally {
    await browser.close();
    await down({ name: NAME });
    rmSync(corpus, { recursive: true, force: true });
  }
}

async function encode(theme, frames) {
  if (frames.length < 2) throw new Error(`no frames captured for ${theme}`);
  const out = resolve(opt.out);
  mkdirSync(out, { recursive: true });
  const fps = Number(opt.fps);
  const width = Number(opt.width);
  const dir = mkdtempSync(join(tmpdir(), "readme-demo-"));
  const list = [];
  const end = frames.at(-1).at + 0.5;
  for (const [index, frame] of frames.entries()) {
    const file = join(dir, `${String(index).padStart(5, "0")}.png`);
    writeFileSync(file, frame.data);
    const next = frames[index + 1]?.at ?? end;
    list.push(`file '${file}'`, `duration ${Math.max(next - frame.at, 0.001).toFixed(3)}`);
  }
  list.push(`file '${join(dir, `${String(frames.length - 1).padStart(5, "0")}.png`)}'`);
  writeFileSync(join(dir, "list.txt"), `${list.join("\n")}\n`);
  const scale = frames[0].data.readUInt32BE(16) / VIEWPORT.width;
  console.log(`${theme}: ${frames.length} frames at ${scale}x the viewport, ${(end - frames[0].at).toFixed(1)} s`);
  // Frames of differing size (a resize mid-run) are scaled to one size first.
  const filter = [
    `scale=${Math.round(VIEWPORT.width * scale)}:${Math.round(VIEWPORT.height * scale)}`,
    ...(width === VIEWPORT.width ? [] : [`scale=${width}:-2:flags=lanczos`]),
    `fps=${fps}`,
  ].join(",");
  const mp4 = join(out, `archer-demo-${theme}.mp4`);
  const webp = join(out, `archer-demo-${theme}.webp`);
  const poster = join(out, `archer-demo-${theme}.png`);
  const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  const input = ["-f", "concat", "-safe", "0", "-i", join(dir, "list.txt")];
  ff(
    ...input,
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "18",
    "-tune",
    "animation",
    "-movflags",
    "+faststart",
    mp4,
  );
  const stills = join(dir, "out");
  mkdirSync(stills);
  ff(...input, "-vf", filter, join(stills, "%05d.png"));
  const pngs = readdirSync(stills)
    .sort()
    .map((name) => join(stills, name));
  execFileSync("img2webp", [
    "-loop",
    "0",
    ...{ lossless: ["-lossless", "-q", "75"], mixed: ["-mixed", "-q", "90"], lossy: ["-lossy", "-q", "90"] }[opt.webp],
    "-m",
    "6",
    "-d",
    String(Math.round(1000 / fps)),
    ...pngs,
    "-o",
    webp,
  ]);
  ff("-ss", String(posterAt), "-i", mp4, "-frames:v", "1", poster);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${theme}: ${mp4}, ${webp}, ${poster}`);
}

let posterAt = 8; // set from the run: the walkthrough's second step
const themes = opt.theme === "both" ? ["light", "dark"] : [opt.theme];
for (const theme of themes) {
  const frames = await run(theme);
  if (!opt["no-encode"]) await encode(theme, frames);
}
