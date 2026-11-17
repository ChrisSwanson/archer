// R1 measurements share the harness browser lifetime, trace, HAR, logs and step evidence.
// Existing journeys may call a tool's measure(page, options) in step() without another browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { openSandbox, withPage } from "./index.mjs";

export function writeMeasurement(out, name, result) {
  mkdirSync(out, { recursive: true });
  const paths = { json: join(out, `${name}.json`), markdown: join(out, `${name}.md`) };
  writeFileSync(paths.json, JSON.stringify(result, null, 2) + "\n");
  writeFileSync(
    paths.markdown,
    result.summary ??
      `# ${name}\n\n${result.status ?? (result.pass === false ? "FAIL" : "Recorded")}\n\nSee [raw JSON](./${name}.json).\n`,
  );
  return paths;
}

export async function runMeasurement({
  name,
  url,
  out = `tools/devkit/runs/${name}-${Date.now()}`,
  measure,
  sandbox,
  theme = "light",
  viewport = { width: 1500, height: 900 },
  ignoreHTTPSErrors = false,
  ...options
}) {
  if (!url && !sandbox) throw new Error("provide --url <access link> or --sandbox <name>");
  const sb = sandbox
    ? typeof sandbox === "string"
      ? openSandbox(sandbox)
      : sandbox
    : { name: "external", origin: new URL(url).origin, url, link: url, projects: [] };
  url ??= sb.link;
  out = resolve(out);
  let result;
  const harness = await withPage(
    async ({ page, step, run }) => {
      await step("visit measurement access link", async () => {
        const response = await page.goto(url);
        if (!response || response.status() >= 400) throw new Error(`measurement page answered ${response?.status()}`);
        if (options.surface?.startsWith("http") && page.url() !== options.surface) {
          const target = await page.goto(options.surface);
          if (!target || target.status() >= 400) throw new Error(`measurement surface answered ${target?.status()}`);
        }
        await page.locator("main, body").first().waitFor({ state: "visible" });
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
      });
      await step(`measure ${name}`, async () => {
        await page.emulateMedia({ colorScheme: theme === "system" ? "light" : theme });
        await page.evaluate((theme) => {
          if (theme === "system") document.documentElement.removeAttribute("data-theme");
          else document.documentElement.setAttribute("data-theme", theme);
        }, theme);
        // The probe reads and labels its current route; it does not infer successful auth from HTTP 200.
        result = await measure(page, { ...options, surface: options.surface ?? page.url(), theme, run });
      });
    },
    {
      name,
      sandbox: sb,
      outDir: join(out, "harness"),
      login: false,
      ignoreHTTPSErrors,
      viewport,
      maxMs: 120000,
      traceSnapshots: false,
      entryShots: false,
    },
  );
  result ??= { status: "incomplete", pass: false, error: "measurement did not run; see harness failures" };
  if (!harness.ok)
    result = {
      ...result,
      measurementStatus: result.status,
      status: "incomplete",
      pass: false,
      summary: `# ${name}: INCOMPLETE\n\nHarness execution failed. See [harness summary](./harness/summary.json). The probe's measurements follow; they cannot certify a pass.\n\n${result.summary ?? ""}`,
    };
  result = {
    schema: `archer-${name}/1`,
    generatedAt: new Date().toISOString(),
    url,
    theme,
    viewport,
    ...result,
    harness: { ok: harness.ok, summary: harness.artifacts.summary, failures: harness.failures },
  };
  writeMeasurement(out, name, result);
  return result;
}

export async function measurementCli({ name, measure, argv = process.argv.slice(2) }) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      out: { type: "string" },
      sandbox: { type: "string" },
      theme: { type: "string", default: "light" },
      width: { type: "string", default: "1500" },
      height: { type: "string", default: "900" },
      surface: { type: "string" },
      "ignore-https-errors": { type: "boolean" },
    },
  });
  if (!["light", "dark", "system"].includes(values.theme)) throw new Error("--theme must be light, dark or system");
  const report = await runMeasurement({
    name,
    measure,
    ...values,
    ignoreHTTPSErrors: values["ignore-https-errors"],
    viewport: { width: Number(values.width), height: Number(values.height) },
  });
  console.log(
    JSON.stringify({
      name,
      status: report.status,
      pass: report.pass,
      counts: report.counts,
      out: values.out,
      harness: report.harness,
    }),
  );
  process.exitCode = report.pass === false || report.status === "incomplete" ? 1 : 0;
  return report;
}
