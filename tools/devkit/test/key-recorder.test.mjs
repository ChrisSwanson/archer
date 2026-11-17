// node --test tools/devkit/test/key-recorder.test.mjs
// The in-page key recorder (harness/key-recorder.mjs) in a real Chromium, judged by the shortcut-focus invariant.
// The page here is a bare text field whose Enter commits and closes it, as the label editor does.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { keyRecorder } from "../harness/key-recorder.mjs";
import { shortcutFocus } from "../harness/invariants.mjs";

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

/** A page with one field; Enter commits and removes it (focus falls to <body>); `g` is a shortcut that steals focus. */
async function fieldPage() {
  const page = await browser.newPage();
  await page.setContent(`<textarea id="f" aria-label="Label"></textarea><div class="authoring-workspace"></div>`);
  await page.evaluate(() => {
    window.__keys = [];
    window.__harnessReport = (r) => window.__keys.push(r);
    const f = document.getElementById("f");
    f.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        f.blur();
        f.remove();
      }
    });
  });
  await page.evaluate(keyRecorder);
  await page.focus("#f");
  return page;
}
const settled = (page) => page.evaluate(() => new Promise((r) => setTimeout(() => r(window.__keys), 30)));

test("key recorder: a burst of queued keys (type, Backspace, Enter) is judged key by key, not after Enter (O18)", async () => {
  const page = await fieldPage();
  // Chromium runs queued input ahead of timers: model a burst that arrived while the main thread was busy by
  // dispatching every key's keydown/input/keyup in one task, so no timer can run between them.
  await page.evaluate(() => {
    const f = document.getElementById("f");
    const key = (k, edit) => {
      const target = document.activeElement;
      const down = new KeyboardEvent("keydown", {
        key: k,
        code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
        bubbles: true,
        cancelable: true,
      });
      if (target.dispatchEvent(down) && edit) {
        f.value = edit(f.value);
        f.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      }
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keyup", { key: k, code: down.code, bubbles: true }),
      );
    };
    key("a", (v) => v + "a");
    key("b", (v) => v + "b");
    key("Backspace", (v) => v.slice(0, -1));
    key("Enter");
  });
  const keys = await settled(page);
  await page.close();
  assert.deepEqual(
    keys.map((k) => k.key),
    ["a", "b", "Backspace", "Enter"],
  );
  const b = keys.find((k) => k.key === "b");
  assert.deepEqual([b.focusMoved, b.valueChanged], [false, true], "b went into the field, which still had focus");
  const verdict = shortcutFocus(keys);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.details));
});

test("key recorder: real typing then Enter passes", async () => {
  const page = await fieldPage();
  await page.keyboard.type("c?1 Dd");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Enter");
  const keys = await settled(page);
  await page.close();
  assert.equal(keys.length, 8);
  const verdict = shortcutFocus(keys);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.details));
});

test("key recorder: a shortcut that pulls focus out of the field to <body> is still a stolen key", async () => {
  const page = await fieldPage();
  await page.evaluate(() =>
    document.getElementById("f").addEventListener("keydown", (e) => {
      if (e.key === "g") {
        e.preventDefault();
        e.target.blur();
      }
    }),
  );
  await page.keyboard.type("ag");
  const keys = await settled(page);
  await page.close();
  const verdict = shortcutFocus(keys);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.details.stolen[0].key, "g");
  assert.equal(verdict.details.stolen[0].focusAfter.tag, "body");
});

test("key recorder: a key the field never took (keydown or beforeinput cancelled) is still a stolen key", async () => {
  for (const cancel of ["keydown", "beforeinput"]) {
    const page = await fieldPage();
    await page.evaluate(
      (type) =>
        document.getElementById("f").addEventListener(type, (e) => {
          if (e.key === "x" || e.data === "x") e.preventDefault();
        }),
      cancel,
    );
    await page.keyboard.type("axb");
    const keys = await settled(page);
    const value = await page.inputValue("#f");
    await page.close();
    assert.equal(value, "ab", cancel);
    const verdict = shortcutFocus(keys);
    assert.equal(verdict.ok, false, cancel);
    assert.deepEqual(
      verdict.details.stolen.map((s) => s.key),
      ["x"],
      cancel,
    );
  }
});
