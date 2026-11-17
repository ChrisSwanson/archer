// Run after docs:build against docs:preview. Verify the reference and guide surfaces only.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { JSDOM } from "jsdom";
import { guideDocuments } from "./documents.mts";
import { mermaidFamilies } from "./mermaid-pages.mts";
import { siteBase } from "../site.config.ts";

const origin = process.env.ARCHER_DOCS_PREVIEW ?? "http://127.0.0.1:4173";
const root = `${origin}${siteBase}`;
const routes = [
  ...guideDocuments.map((page) => page.path),
  "generated/cli",
  "supported-mermaid/",
  ...mermaidFamilies.map((family) => `supported-mermaid/${family.slug}`),
  "supported-mermaid/rules",
];
const output = process.env.ARCHER_DOCS_SCREENSHOTS ?? ".shots/docs-ia";
await mkdir(output, { recursive: true });
if (process.argv.includes("--static")) {
  const checked = new Set();
  for (const route of routes) {
    const response = await fetch(`${root}${route}`);
    assert.equal(response.status, 200, route);
    const document = new JSDOM(await response.text(), { url: response.url }).window.document;
    assert.equal(document.querySelectorAll("h1").length, 1, route);
    for (const anchor of document.querySelectorAll("a[href]")) {
      const target = new URL(anchor.href);
      if (target.origin !== origin || checked.has(target.href)) continue;
      checked.add(target.href);
      assert(!/security\/(known-limits|$)/.test(target.pathname), `Removed reference: ${target.href}`);
      const result = await fetch(target);
      assert.equal(result.status, 200, `Dead link: ${target.href}`);
      if (target.hash) {
        const linked = new JSDOM(await result.text()).window.document;
        assert(linked.getElementById(decodeURIComponent(target.hash.slice(1))), `Missing anchor: ${target.href}`);
        linked.defaultView.close();
      }
    }
    document.defaultView.close();
  }
  for (const name of ["install.sh", "llms.txt", "llms-full.txt"]) {
    const result = await fetch(`${root}${name}`);
    assert.equal(result.status, 200, name);
    assert((await result.text()).startsWith(name === "install.sh" ? "#!/bin/sh" : "# Archer"), name);
  }
  for (const route of ["security/known-limits.html", "security/index.html"])
    assert.equal((await fetch(`${root}${route}`)).status, 404, route);
  console.log(
    `Static reference checks passed: ${routes.length} pages, ${checked.size} links and anchors, 3 public text artifacts, 2 removed routes. Browser layout and axe not checked.`,
  );
} else {
  const browser = await chromium.launch();
  const errors = [];
  const checkedLinks = new Set();
  let scans = 0;
  try {
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await context.addInitScript((value) => localStorage.setItem("vitepress-theme-appearance", value), theme);
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        for (const route of routes) {
          const response = await page.goto(`${root}${route}`, { waitUntil: "networkidle" });
          assert.equal(response.status(), 200, route);
          await page.locator("h1").waitFor();
          assert.equal(await page.locator("h1").count(), 1, route);
          assert(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${route} at ${width}: page overflow`,
          );
          const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => anchor.href));
          for (const href of links) {
            const target = new URL(href);
            if (target.origin !== origin || checkedLinks.has(href)) continue;
            checkedLinks.add(href);
            assert(!/security\/(known-limits|$)/.test(target.pathname), `Removed reference: ${href}`);
            const result = await page.request.get(href);
            assert.equal(result.status(), 200, `Dead link: ${href}`);
            if (target.hash)
              assert(
                (await result.text()).includes(`id="${decodeURIComponent(target.hash.slice(1))}"`),
                `Missing anchor: ${href}`,
              );
          }
          if (route === "supported-mermaid/flowchart") {
            const disclosure = page.locator("details").first();
            await disclosure.locator("summary").focus();
            await page.keyboard.press("Enter");
            assert(await disclosure.evaluate((element) => element.open), "Syntax details open from keyboard");
          }
          const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
          assert.deepEqual(
            axe.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
            [],
            `${route} ${width} ${theme}: accessibility`,
          );
          scans++;
          if (
            [
              "install",
              "generated/cli",
              "supported-mermaid/",
              "supported-mermaid/flowchart",
              "security/network-access",
            ].includes(route)
          ) {
            await page.screenshot({ path: `${output}/${route.replaceAll("/", "-")}-${width}-${theme}.png` });
          }
        }
        for (const name of ["install.sh", "llms.txt", "llms-full.txt"]) {
          const result = await page.request.get(`${root}${name}`);
          assert.equal(result.status(), 200, name);
          const body = await result.text();
          assert(!body.startsWith("<!DOCTYPE"), `${name} is a raw text artifact`);
          assert(body.includes(name === "install.sh" ? "#!/bin/sh" : "# Archer"), name);
        }
        for (const route of ["security/known-limits.html", "security/index.html"])
          assert.equal((await page.request.get(`${root}${route}`)).status(), 404, route);
        await context.close();
      }
    }
    assert.deepEqual(errors, [], "Browser errors");
    console.log(
      `Reference browser checks passed: ${routes.length} pages, ${scans} axe scans, desktop/phone, light/dark; ${checkedLinks.size} links. Screenshots: ${output}`,
    );
  } finally {
    await browser.close();
  }
}
