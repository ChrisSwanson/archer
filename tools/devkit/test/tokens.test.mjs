import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { auditCss, measureTokens } from "../harness/tokens.mjs";
const fixture = (name) => readFileSync(new URL(`../fixtures/token-${name}.css`, import.meta.url), "utf8");
test("token census accepts token sizes and detects the planted 13px label", () => {
  const pass = auditCss(fixture("pass"), { file: "token-pass.css" });
  assert.equal(pass.ok, true);
  assert.deepEqual(pass.counts, {
    fontSize: { raw: 0, tokens: 1 },
    iconSize: { raw: 0, tokens: 2 },
    spacing: { raw: 0, tokens: 1 },
  });
  const fail = auditCss(fixture("fail"), { file: "token-fail.css" });
  assert.equal(fail.ok, false);
  assert.equal(fail.counts.fontSize.raw, 1);
  assert.equal(fail.declarations.find((d) => d.raw).line, 3);
});
test("counts declaration occurrences, ignores comments/custom properties and includes numeric var fallbacks", () => {
  const result = auditCss(`:root { --type-x: 13px; } /* .x {font-size:13px} */
 .icon {width: 13px; height: var(--icon, 20px)}
 .text { font-size: calc(var(--type-body) + 1px); padding: 0 8px 0 8px; margin: 0; gap: var(--space, 2px); content: 'font-size: 99px;'; }
 .button { width: 13px; }`);
  assert.deepEqual(result.counts, {
    fontSize: { raw: 1, tokens: 1 },
    iconSize: { raw: 2, tokens: 1 },
    spacing: { raw: 2, tokens: 1 },
  });
});
test("computed-style census reports a token pass and a visible 13px failure, excluding CSS-hidden text", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<style>${fixture("pass")} .hidden {display:none} .sr-only {position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}</style><span class="label">Token label</span><span class="hidden" style="font-size:99px">Hidden</span><span class="sr-only" style="font-size:98px">Screen-reader label</span>`,
    );
    const pass = await measureTokens(page, { surface: "planted-token-pass" });
    assert.deepEqual(pass.sizes, [14]);
    assert.equal(pass.offScale.length, 0);
    await page.addStyleTag({ content: fixture("fail") });
    const fail = await measureTokens(page, { surface: "planted-token-fail" });
    assert.deepEqual(fail.sizes, [13]);
    assert.equal(fail.offScale.length, 1);
    assert.equal(fail.offScale[0].fontSizePx, 13);
  } finally {
    await browser.close();
  }
});
