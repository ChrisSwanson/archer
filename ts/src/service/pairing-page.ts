// The page a browser without an Archer credential sees: at `/`, and (as a 404) at any page-shaped
// address it was refused. Same bytes everywhere, so it reveals nothing about which projects exist.
// It comes before the application shell: no project, scope or capability exists until the browser
// holds a credential, so it is a static page with one form (ADR 0014, amended 2026-10-22: pairing).
// The form is an ordinary same-origin POST of `code` to `/-/pair` (security round 1, decision D5):
// the code goes in the body, never in a URL, and a correct one answers one 303 to `/projects/` with the
// session cookie, like a link's exchange. A refused one answers this page again with the reason. The
// script only tidies what is typed and catches a code of the wrong length before it is sent; without it
// the form still works.

/**
 * The stylesheet of the pages the service answers outside the application: this one, the refused page
 * and the not-found page (`http.ts`). Archer's own colour tokens (`ui/src/styles.css`) in both schemes and its
 * type ramp, with the background, text and link colours set, so nothing falls to the browser's
 * defaults (round 1, P9: the dark scheme's default link colour read against an assumed white).
 */
export const ACCESS_PAGE_STYLE = `:root{color-scheme:light dark;--bg:#f8f7f4;--text:#1f1d1a;--text-dim:#5c5850;--accent:#2645a3;--accent-ink:#fff;--danger-strong:#b3452a;--type-small:.75rem;--type-body:.875rem;--type-title:1.0625rem;--type-display:1.375rem}
@media (prefers-color-scheme:dark){:root{--bg:#141311;--text:#eeebe5;--text-dim:#aaa49a;--accent:#9db4ff;--accent-ink:#101a3a;--danger-strong:#ff8a7a}}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:var(--type-body);line-height:1.5}
main{max-width:30rem;margin:12vh auto 2rem;padding:0 16px}h1{font-size:var(--type-display);margin:0 0 1rem}
a{color:var(--accent)}
label{display:block;font-weight:600;margin-bottom:.375rem}
.row{display:flex;gap:.5rem}
input{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--type-display);font-weight:600;line-height:1.2;letter-spacing:.12em;text-transform:uppercase;padding:.625rem .75rem;border:1px solid var(--text-dim);border-radius:6px;background:transparent;color:inherit}
input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
button{font:inherit;font-weight:600;min-height:44px;padding:0 1.25rem;border:0;border-radius:6px;background:var(--accent);color:var(--accent-ink);cursor:pointer}
button:disabled{opacity:.6;cursor:progress}
.hint,.alt{color:var(--text-dim);margin:.5rem 0 0}.alt{margin-top:2rem}
#error{color:var(--danger-strong);font-weight:600;margin:.75rem 0 0;min-height:1.5em}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:inherit}`;

/** `/-/pair` reads no more than this; the form sends its return only when code and return fit (`http.ts`). */
export const MAX_PAIR_BODY_BYTES = 256;

const MESSAGES = {
  code_invalid: "Not a valid code: it has 8 letters and digits, like 7KQ4-M2XD.",
  code_wrong: "Not a valid code. Check it and try again.",
  code_expired: "This code expired: ask for a new one.",
  code_used:
    "This code was already used. If that wasn't you, ask for a new code and ask the agent to revoke the pairing you didn't make.",
  too_many_tries_wait: "Too many tries: wait a minute, then try again.",
  too_many_tries: "Too many tries: ask for a new code.",
  internal: "Archer could not sign this browser in. Ask for a new code.",
};

// The return (decided 2026-11-02; claude-09): the refused page's "Enter it here" link arrives with that page's address
// as a same-origin referrer. The script puts its path in the form's hidden field (its query too, unless a key names
// a credential), and keeps it in this tab for the answer to a wrong code (the same page, at `/-/pair`). It is sent
// only when it fits the body cap with a code; `/-/pair` checks it again and lands anywhere else on `/projects/`.
// Opened any other way, nothing is kept or sent.
const SCRIPT = `(() => {
const form = document.getElementById("pair"), input = document.getElementById("code"), button = form.querySelector("button"), error = document.getElementById("error");
const back = document.getElementById("return"), KEPT = "archer.pair-return";
try {
  let path = null;
  if (location.pathname === "/-/pair") path = sessionStorage.getItem(KEPT);
  else {
    const from = document.referrer === "" ? null : new URL(document.referrer);
    if (from !== null && from.origin === location.origin && from.pathname.startsWith("/projects/")) {
      let search = from.search;
      for (const key of new URLSearchParams(search).keys()) if (/token|grant|secret|key|cookie|auth|bearer|passw|credential|sig|code|pairing|session/i.test(key)) search = "";
      path = from.pathname + search;
    }
  }
  const fits = path !== null && new URLSearchParams({ code: "XXXX-XXXX", return: path }).toString().length <= ${MAX_PAIR_BODY_BYTES};
  if (fits) { back.value = path; back.disabled = false; sessionStorage.setItem(KEPT, path); }
  else sessionStorage.removeItem(KEPT);
} catch { /* no storage, or a referrer that is no URL: what was set stands */ }
const invalid = ${JSON.stringify(MESSAGES.code_invalid)};
const show = (text) => { error.textContent = text; input.setAttribute("aria-invalid", text === "" ? "false" : "true"); };
input.addEventListener("input", () => {
  const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  const shown = raw.length > 4 ? raw.slice(0, 4) + "-" + raw.slice(4) : raw;
  if (shown !== input.value) input.value = shown;
  if (error.textContent !== "") show("");
});
form.addEventListener("submit", (event) => {
  if (button.disabled) { event.preventDefault(); return; }
  if (input.value.replace(/[^0-9A-Za-z]/g, "").length !== 8) { event.preventDefault(); show(invalid); input.focus(); return; }
  // One submission at a time; the browser sends the form and follows the answer.
  setTimeout(() => { button.disabled = true; });
});
// Back to this page from the history: the form is usable again.
addEventListener("pageshow", () => { button.disabled = false; });
})();`;

/** A reason the exchange refused a code (the `/-/pair` refusal names), or the service failing to answer. */
export type PairingMessage = keyof typeof MESSAGES;

function render(message: PairingMessage | undefined): Buffer {
  const text = message === undefined ? "" : MESSAGES[message];
  return Buffer.from(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Archer</title><style>${ACCESS_PAGE_STYLE}</style></head>
<body><main><h1>Open Archer</h1>
<form id="pair" method="post" action="/-/pair" novalidate>
<input id="return" name="return" type="hidden" disabled>
<label for="code">Enter your pairing code</label>
<div class="row"><input id="code" name="code" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="9" placeholder="XXXX-XXXX" aria-describedby="hint error" aria-invalid="${text === "" ? "false" : "true"}" autofocus required><button type="submit">Open</button></div>
<p id="error" role="alert">${text}</p>
<p id="hint" class="hint">Ask the agent for a pairing code, or run <code>archer pair</code> on the computer running Archer. A code works once, for a few minutes.</p>
</form>
<p class="alt">Have a link instead? Open the link Archer gave you, or one someone shared with you. If it has expired or isn't valid, ask for a new one.</p>
</main><script>${SCRIPT}</script></body></html>
`,
    "utf8",
  );
}

export const PAIRING_PAGE = render(undefined);
const REFUSED = new Map<PairingMessage, Buffer>(
  Object.keys(MESSAGES).map((key) => [key as PairingMessage, render(key as PairingMessage)]),
);
/** The form again, saying why the code was refused (fixed text; nothing the browser sent is echoed). */
export function pairingPage(message: PairingMessage): Buffer {
  return REFUSED.get(message)!;
}
