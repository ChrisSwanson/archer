/**
 * Records the landing film (`LandingFilm.vue`) for the repository README: one loop of it in the light and the dark
 * theme, as animated WebP (inline on GitHub, autoplays) and MP4 (to link), plus a still poster of each.
 *
 *   npm run docs:build && npx vitepress preview site --port 4173 &
 *   node --import tsx site/scripts/readme-film.mts [--base http://localhost:4173/archer/] [--out docs/media]
 *
 * Needs ffmpeg and img2webp on PATH. Chromium's screencast sends a frame whenever the page repaints, each with its
 * own timestamp, so the frames are assembled at the times they were painted, not at a fixed rate.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { FILM_FRAMES } from "../.vitepress/theme/landing-film.mts";

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1]! : fallback;
};
const base = arg("base", "http://localhost:4173/archer/");
const out = resolve(arg("out", "docs/media"));
const width = Number(arg("width", "1200")); // output width in pixels
const fps = Number(arg("fps", "20"));
const loopMs = FILM_FRAMES.reduce((sum, frame) => sum + frame.ms, 0);

async function record(theme: "light" | "dark") {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await page.goto(base);
  const film = page.locator(".film-pair");
  const session = await context.newCDPSession(page);
  const frames: { data: Buffer; at: number }[] = [];
  session.on("Page.screencastFrame", (event) => {
    frames.push({ data: Buffer.from(event.data, "base64"), at: event.metadata.timestamp! });
    session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  // A looping image cannot be paused: hide the control rather than show one nobody can press.
  await page.addStyleTag({ content: ".film-toggle { visibility: hidden; }" });
  await film.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.waitForSelector('[data-film-running="true"]');
  await session.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 2720, maxHeight: 1800 });
  await page.waitForTimeout(loopMs + 400);
  await session.send("Page.stopScreencast");
  const tight = (await film.boundingBox())!;
  const pad = 24; // a margin of the landing's own stage around the film
  const box = { x: tight.x - pad, y: tight.y - pad, width: tight.width + 2 * pad, height: tight.height + 2 * pad };
  await browser.close();
  return { frames, box };
}

async function encode(theme: "light" | "dark") {
  const { frames, box } = await record(theme);
  if (frames.length < 2) throw new Error(`no frames captured for ${theme}`);
  const dir = await mkdtemp(join(tmpdir(), "readme-film-"));
  const list: string[] = [];
  const start = frames[0]!.at;
  const end = start + loopMs / 1000;
  const kept = frames.filter((frame) => frame.at <= end);
  for (const [index, frame] of kept.entries()) {
    const file = join(dir, `${String(index).padStart(5, "0")}.png`);
    await writeFile(file, frame.data);
    const next = kept[index + 1]?.at ?? end;
    list.push(`file '${file}'`, `duration ${Math.max(next - frame.at, 0.001).toFixed(3)}`);
  }
  list.push(`file '${join(dir, `${String(kept.length - 1).padStart(5, "0")}.png`)}'`);
  await writeFile(join(dir, "list.txt"), `${list.join("\n")}\n`);
  // The screencast frame is the viewport at device scale; crop to the film, then scale to the README width.
  const scale = frames[0]!.data.readUInt32BE(16) / 1360; // the PNG's width over the viewport's
  console.log(`${theme}: frames at ${scale}× the viewport`);
  const filter = [
    `crop=${Math.round(box.width * scale)}:${Math.round(box.height * scale)}:${Math.round(box.x * scale)}:${Math.round(box.y * scale)}`,
    `scale=${width}:-2:flags=lanczos`,
    `fps=${fps}`,
  ].join(",");
  const mp4 = join(out, `archer-film-${theme}.mp4`);
  const webp = join(out, `archer-film-${theme}.webp`);
  const poster = join(out, `archer-film-${theme}.png`);
  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  const input = ["-f", "concat", "-safe", "0", "-i", join(dir, "list.txt")];
  ff(...input, "-vf", filter, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-movflags", "+faststart", mp4);
  // This ffmpeg may lack libwebp: write the frames at the output rate and let img2webp assemble them.
  const stills = join(dir, "out");
  await mkdir(stills);
  ff(...input, "-vf", filter, join(stills, "%05d.png"));
  const pngs = (await readdir(stills)).sort().map((name) => join(stills, name));
  execFileSync("img2webp", [
    "-loop",
    "0",
    "-lossy",
    "-q",
    "70",
    "-m",
    "4",
    "-d",
    String(Math.round(1000 / fps)),
    ...pngs,
    "-o",
    webp,
  ]);
  // The poster: the walkthrough's second step, where the film shows the most of what Archer does.
  ff("-ss", "6", "-i", mp4, "-frames:v", "1", poster);
  await rm(dir, { recursive: true, force: true });
  console.log(`${theme}: ${kept.length} frames → ${mp4}, ${webp}, ${poster}`);
}

await mkdir(out, { recursive: true });
for (const theme of ["light", "dark"] as const) await encode(theme);
