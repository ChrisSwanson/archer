import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import {
  collectCheckpoint,
  columnCheckbox,
  highlights,
  deleteShape,
  commentPin,
  dirtySettings,
  matches,
} from "../harness/m2-probes.mjs";
let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});
async function withPage(html, run) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    await run(page);
  } finally {
    await page.close();
  }
}

test("F15 collector distinguishes coverage absent, action not executed and destination wrong", async () => {
  await withPage("<button>Start</button><button>Wrong destination</button>", async (page) => {
    const absent = await collectCheckpoint(page, async () => ({ skip: "no fixture" }));
    assert.equal(absent.outcome, "coverage absent");
    const idle = await collectCheckpoint(page, async () => ({ executed: false, reason: "refused" }));
    assert.equal(idle.outcome, "action not executed");
    const wrong = await collectCheckpoint(page, async () => ({ executed: true, destinationCorrect: false }));
    assert.equal(wrong.outcome, "destination wrong");
    const right = await collectCheckpoint(page, async () => ({ executed: true, destinationCorrect: true }));
    assert.equal(right.outcome, "destination correct");
  });
});

test("F06 scopes the checkbox to Table Columns and never toggles the Notes kind filter", async () => {
  await withPage(
    `<div role="dialog" aria-label="Project Filters"><label><input type="checkbox">Diagrams</label><label><input id="notes" type="checkbox">Notes</label><section data-section="table-columns"><h3>Table Columns</h3><label><input id="column" type="checkbox">Created</label></section></div><script>window.toggles=[];document.addEventListener('change',e=>toggles.push(e.target.id));</script>`,
    async (page) => {
      const result = await collectCheckpoint(page, columnCheckbox);
      assert.deepEqual(await page.evaluate(() => toggles), ["column", "column"]);
      assert.equal(result.outcome, "destination correct");
    },
  );
});
test("F06 reports coverage absent when only file kind checkboxes exist", async () => {
  await withPage(
    `<div role="dialog" aria-label="Project Filters"><label><input type="checkbox">Diagrams</label><label><input id="notes" type="checkbox">Notes</label></div>`,
    async (page) => {
      const result = await collectCheckpoint(page, columnCheckbox);
      assert.equal(result.outcome, "coverage absent");
      assert.equal(await page.locator("#notes").isChecked(), false);
    },
  );
});
for (const on of [false, true])
  for (const off of [false, true]) {
    test(`F22/F23 establishes Highlights off before activation (initial=${on}, F23=${off})`, async () => {
      await withPage(
        `<button aria-pressed="${on}" onclick="this.setAttribute('aria-pressed',this.getAttribute('aria-pressed')==='true'?'false':'true');document.querySelector('p').hidden=this.getAttribute('aria-pressed')==='true'">Highlights</button><p ${on ? "hidden" : ""}>Explore</p>`,
        async (page) => {
          const states = [];
          const result = await collectCheckpoint(page, (p, rec) =>
            highlights(
              p,
              async (at) => {
                states.push(await p.getByRole("button").getAttribute("aria-pressed"));
                await rec(at);
              },
              { off },
            ),
          );
          assert.equal(await page.getByRole("button").getAttribute("aria-pressed"), off ? "false" : "true");
          assert.equal(states[0], "true");
          assert.equal(result.outcome, "destination correct");
          if (off) assert.equal(await page.getByText("Explore", { exact: true }).isVisible(), true);
        },
      );
    });
  }
const editor = `<div class="authoring-workspace"><div class="authoring-parts"><button id="add">Process</button></div><div class="react-flow__node" tabindex="0" data-id="connected" data-connected="true">Connected node</div></div><script>
  const root=document.querySelector('.authoring-workspace');
  add.onclick=()=>{const field=document.createElement('input');field.className='archer-node-label-input';root.append(field);field.focus();field.onkeydown=e=>{if(e.key==='Enter'){const n=document.createElement('div');n.className='react-flow__node';n.dataset.id='new-probe';n.tabIndex=0;n.textContent=field.value;root.append(n);field.remove();n.focus();}}};
  document.addEventListener('keydown',e=>{const n=document.activeElement;if(n.matches('.react-flow__node')) {if(e.key===' '){e.preventDefault();n.setAttribute('aria-pressed','true');}if(e.key==='Delete'&&n.getAttribute('aria-pressed')==='true'&&!n.dataset.connected){n.remove();root.querySelector('.react-flow__node').focus();}}});</script>`;
test("F35 deletes a newly added unconnected node and confirms the node count really falls", async () => {
  await withPage(editor, async (page) => {
    const result = await collectCheckpoint(page, deleteShape);
    assert.equal(result.outcome, "destination correct", JSON.stringify(result));
    assert.equal(result.evidence.before, 2);
    assert.equal(result.evidence.after, 1);
    assert.equal(await page.getByText("Connected node").count(), 1);
  });
});
test("F35 reports action not executed when the editor refuses deletion", async () => {
  await withPage(editor.replace("n.remove();", "return;"), async (page) => {
    const result = await collectCheckpoint(page, (p, rec) => deleteShape(p, rec, { timeout: 150 }));
    assert.equal(result.outcome, "action not executed", JSON.stringify(result));
  });
});
const pinPage = (returnToPin) =>
  `<span class="archer-pin" data-pin-thread="one" onclick="discussion.hidden=false;document.querySelector('#thread').focus()">1</span><section id="discussion" role="region" aria-label="Contextual discussion" hidden><article id="thread" tabindex="-1">Thread</article></section><button id="owner">Node</button><script>document.addEventListener('keydown',e=>{if(e.key==='Escape'){discussion.hidden=true;${returnToPin ? "document.querySelector('[data-pin-thread]').tabIndex=-1;document.querySelector('[data-pin-thread]').focus();" : "owner.focus();"}}});</script>`;
for (const returns of [false, true])
  test(`F52 clicks a nonfocusable pin and distinguishes its Escape return (correct=${returns})`, async () => {
    await withPage(pinPage(returns), async (page) => {
      const observations = [];
      const result = await collectCheckpoint(page, (p, rec) =>
        commentPin(p, async (at) => {
          observations.push(await page.evaluate(() => document.activeElement.id));
          await rec(at);
        }),
      );
      assert.equal(observations[0], "thread");
      assert.equal(result.outcome, returns ? "destination correct" : "destination wrong", JSON.stringify(result));
      assert.equal(result.executed, true);
    });
  });
const settings = `<div role="dialog" aria-label="Project Settings"><button id="close">Close settings</button><label>Name<input id="name" value="Journeys" readonly></label><label>Description<input id="description" readonly></label><label><input type="radio" name="visibility" checked>Automatic</label><label><input type="radio" name="visibility" id="always">Always show</label></div><div role="alertdialog" aria-label="Discard changes?" hidden id="confirmation"><button id="keep">Keep editing</button></div><script>window.dirty=false;always.onchange=()=>dirty=true;document.addEventListener('keydown',e=>{if(e.key==='Escape'&&dirty){confirmation.hidden=false;keep.focus()}});keep.onclick=()=>{confirmation.hidden=true;document.getElementById('close').focus()};</script>`;
test("F90 changes an editable radio, opens the dirty confirmation and checks Keep editing returns to Close settings", async () => {
  await withPage(settings, async (page) => {
    const result = await collectCheckpoint(page, dirtySettings);
    assert.equal(await page.locator("#name").inputValue(), "Journeys");
    assert.equal(await page.locator("#always").isChecked(), true);
    assert.equal(result.outcome, "destination correct", JSON.stringify(result));
    assert.equal(result.evidence.confirmationOpened, true);
  });
});

test("F15 CLI writes three distinct calibrated outcomes into its JSON checkpoint packet", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<button onclick="filters.hidden=false">Filters</button><div id="filters" role="dialog" aria-label="Project Filters" hidden><label><input type="checkbox">Diagrams</label><label><input type="checkbox">Notes</label></div><div class="react-flow__node">Drawing fixture</div><button aria-pressed="false">Highlights</button>${pinPage(false)}`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const out = mkdtempSync(join(tmpdir(), "archer-m2-calibration-"));
  try {
    await new Promise((done, reject) =>
      execFile(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve(import.meta.dirname, "../harness/m2-checkpoints.mjs"),
          "--origin",
          origin,
          "--login",
          origin,
          "--only",
          "F06,F22,F52",
          "--out",
          out,
        ],
        { timeout: 30000 },
        (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : done()),
      ),
    );
    const packet = JSON.parse(readFileSync(join(out, "m2-checkpoints.json"), "utf8"));
    assert.deepEqual(
      packet.results.map((r) => [r.id, r.outcome]),
      [
        ["F06", "coverage absent"],
        ["F22", "action not executed"],
        ["F52", "destination wrong"],
      ],
    );
    assert.match(readFileSync(join(out, "m2-checkpoints.md"), "utf8"), /\| ID \| Outcome \|/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(out, { recursive: true, force: true });
  }
});

const tourFixture = `<div class="react-flow__node" id="web" tabindex="0">Storefront</div><button id="highlight" aria-pressed="true">Highlights · 2</button><button id="membersToggle" class="archer-emph-members-toggle" aria-expanded="false">Members</button><div id="members" class="archer-emph-members" hidden><button onclick="document.getElementById('web').focus()">Storefront</button></div><button id="launch" aria-pressed="false">Walkthroughs · 1</button><section id="panel" class="archer-walk" hidden>
<button class="archer-walk-pick" aria-expanded="false">Walkthrough Checkout tour</button><div id="choices" role="group" aria-label="Walkthroughs on this diagram" hidden><button id="choose">Checkout tour</button></div>
<div role="tablist" aria-label="Panel view"><button role="tab" aria-selected="true">Steps</button><button role="tab" aria-selected="false" tabindex="-1">Sequence</button></div>
<ol aria-label="Steps of Checkout tour">${[1, 2, 3].map((n) => `<li><button class="archer-walk-head" ${n === 1 ? 'aria-current="step"' : ""} data-no="${n}">Step ${n}</button></li>`).join("")}</ol>
<div role="group" aria-label="Step controls"><button aria-label="Next step">Next</button><input type="range" aria-label="Step" min="1" max="3" value="1"></div><button aria-label="Close walkthrough">Close</button></section>
<p id="explore" hidden>Explore</p><button id="follow" aria-label="Follow steps" aria-pressed="false">Follow</button><div aria-live="polite">Step 1 of 3: Step 1.</div><script>
const highlight=document.getElementById('highlight'),membersToggle=document.getElementById('membersToggle');highlight.onclick=()=>{highlight.setAttribute('aria-pressed',String(highlight.getAttribute('aria-pressed')!=='true'));membersToggle.hidden=highlight.getAttribute('aria-pressed')!=='true';document.getElementById('explore').hidden=highlight.getAttribute('aria-pressed')==='true'};membersToggle.onclick=()=>{members.hidden=false;membersToggle.setAttribute('aria-expanded','true')};
const launcher=document.getElementById('launch'),panel=document.getElementById('panel'),range=document.querySelector('input'),next=document.querySelector('[aria-label="Next step"]');
function step(n){range.value=n;document.querySelectorAll('[data-no]').forEach(e=>{if(+e.dataset.no===n)e.setAttribute('aria-current','step');else e.removeAttribute('aria-current')});next.setAttribute('aria-disabled',String(n===3));document.querySelector('[aria-live]').textContent='Step '+n+' of 3: Step '+n+'.';}
launcher.onclick=()=>{panel.hidden=false;launcher.setAttribute('aria-pressed','true');step(1);document.querySelector('[aria-current="step"]').focus()};
const picker=document.querySelector('.archer-walk-pick');picker.onclick=()=>{choices.hidden=false;picker.setAttribute('aria-expanded','true');choose.focus()};choose.onclick=()=>{choices.hidden=true;document.querySelector('[aria-current="step"]').focus()};
next.onclick=()=>step(Math.min(3,+range.value+1));document.querySelectorAll('[data-no]').forEach(e=>e.onclick=()=>step(+e.dataset.no));
const tabs=[...document.querySelectorAll('[role="tab"]')];document.querySelector('[role="tablist"]').onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const index=1-tabs.indexOf(document.activeElement);tabs.forEach((t,i)=>{t.setAttribute('aria-selected',String(i===index));t.tabIndex=i===index?0:-1});tabs[index].focus()}};
follow.onclick=()=>follow.setAttribute('aria-pressed',String(follow.getAttribute('aria-pressed')!=='true'));
function closeTour(){panel.hidden=true;launcher.setAttribute('aria-pressed','false');launcher.focus()};document.querySelector('[aria-label="Close walkthrough"]').onclick=closeTour;document.addEventListener('keydown',e=>{if(e.key==='Escape')closeTour()});</script>`;

test("F15 CLI measures the corpus discussion, checkout tour and unread fixtures instead of hardcoded absent coverage", async () => {
  const { createServer } = await import("node:http");
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url === "/projects/pageturner/diagrams/containers.mmd") return res.end(tourFixture);
    if (req.url === "/projects/pageturner/notes/0001-hosted-payment-page.md")
      return res.end(
        `<button class="primary-note-discussion-bubble" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Open discussion on payment boundary</button><script>document.addEventListener('keydown',e=>{if(e.key==='Escape'){const b=document.querySelector('button');b.setAttribute('aria-expanded','false');b.focus()}})</script>`,
      );
    res.end(
      `<div class="react-flow__node">Drawing</div><button id="bell" onclick="inbox.hidden=false;inbox.focus()">Notifications</button><section id="inbox" role="dialog" aria-label="Notifications" tabindex="-1" hidden><ol><li><button onclick="this.remove();inbox.focus()">Mark read</button></li></ol></section>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const out = mkdtempSync(join(tmpdir(), "archer-m2-corpus-actions-"));
  try {
    await new Promise((done, reject) =>
      execFile(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve(import.meta.dirname, "../harness/m2-checkpoints.mjs"),
          "--origin",
          origin,
          "--login",
          origin,
          "--only",
          "F13,F22,F23,F24,F25,F26,F27,F28,F29,F30,F76",
          "--out",
          out,
        ],
        { timeout: 45000 },
        (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : done()),
      ),
    );
    const packet = JSON.parse(readFileSync(join(out, "m2-checkpoints.json"), "utf8"));
    assert.equal(packet.results.length, 11);
    for (const result of packet.results) assert.equal(result.outcome, "destination correct", JSON.stringify(result));
    assert.ok(requests.includes("/projects/pageturner/notes/0001-hosted-payment-page.md"));
    assert.ok(requests.includes("/projects/pageturner/diagrams/containers.mmd"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(out, { recursive: true, force: true });
  }
});

test("F15 an absent focus destination is rejected before locator.evaluate can wait for it", async () => {
  // Locator.count resolves immediately even when absent; evaluate auto-waits for the default timeout.
  // Instrument that seam rather than asserting wall-clock timings on a busy shared machine.
  let evaluated = false;
  const missingDestination = {
    count: async () => 0,
    evaluate: async () => {
      evaluated = true;
      throw new Error("would wait for a nonexistent destination");
    },
  };
  assert.equal(await matches(missingDestination, () => true), false);
  assert.equal(evaluated, false, "known-absent destination must not enter Playwright auto-wait");
});

test("F90 recognizes Keep editing inside the existing Project settings dialog", async () => {
  const inline = settings
    .replace(
      '</div><div role="alertdialog" aria-label="Discard changes?" hidden id="confirmation">',
      '<div hidden id="confirmation">',
    )
    .replace("</button></div><script>", "</button></div></div><script>");
  await withPage(inline, async (page) => {
    const result = await collectCheckpoint(page, (p, rec) => dirtySettings(p, rec, { timeout: 150 }));
    assert.equal(result.outcome, "destination correct", JSON.stringify(result));
    assert.equal(result.evidence.confirmationOpened, true);
  });
});

test("F35 tracks the added node by stable data-id when SVG wrapping removes label spaces", async () => {
  const wrapped = editor.replace(
    "</script>",
    `document.addEventListener('focusin',e=>{if(e.target.dataset.id==='new-probe')e.target.innerHTML='<svg><text><tspan>M2 unconnected</tspan><tspan>delete probe</tspan></text></svg>';});</script>`,
  );
  await withPage(wrapped, async (page) => {
    page.setDefaultTimeout(250);
    const result = await collectCheckpoint(page, (p, rec) => deleteShape(p, rec, { timeout: 250 }));
    assert.equal(result.outcome, "destination correct", JSON.stringify(result));
    assert.deepEqual(result.evidence, { before: 2, after: 1 });
  });
});
