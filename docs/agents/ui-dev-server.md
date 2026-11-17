# The UI with hot reload, against a running service

For visual work, run the page from source instead of rebuilding the bundle:

```sh
cd ui
ARCHER_DEV_SERVER=http://<service address>:<port> npx vite --port 5173
```

- **Where the service is:** `node ts/dist/archer.js call get_ui_url --stdin --json <<< '{}'`, or
  `~/.local/state/archer/service.json` for the port. Use the address `get_ui_url` reports.
- **Open the link `get_ui_url` reports, on the dev server's origin:**
  `http://localhost:5173/projects/<project>/?follow&token=<token>`. The proxy hands the `?token=` to the
  service, which sets its access cookie and sends the browser back to the clean address here. The page
  calls the service by relative paths, and `ui/vite.config.ts` forwards every request that reaches an
  `api/` path to `ARCHER_DEV_SERVER` (default
  `http://127.0.0.1:40399`). The service refuses changes whose `Origin` is not its own, so the
  proxy presents the dev page's own requests with the service's origin; any other origin passes
  through unchanged and is still refused (a 403 on every write means this rewrite is missing).
- **From another machine:** add `--host 0.0.0.0`. Anyone on the network can then load the page,
  read the diagrams and post selections through the proxy.
- **The docs site with Impeccable:** `cd site && impeccable live-server --background`, then
  `npm run docs:dev` and open `http://localhost:5173/archer/` (VitePress's port). VitePress has no HTML
  entry to inject into, so `site/.vitepress/config.mts` adds the tag itself while the helper runs and
  serves the picker same-origin, with the same loopback rule (`tools/impeccable-live.mts`, shared with
  the UI's dev server). `impeccable live-server stop` from `site/` when done.
- **Dev-only plugins in `ui/vite.config.ts`** (`apply: "serve"`, never in a build): the generated
  validator `*.generated.cjs` is converted to ESM, which Vite otherwise does only at build time;
  and Impeccable's live picker is served from the page's own origin under `/__impeccable/`
  (`tools/impeccable-live.mts`).
- **Impeccable live mode** (`/impeccable live`, config in `ui/.impeccable/live/config.json`)
  injects a `<script>` into `ui/index.html` while it runs. Never commit that tag or build while it
  is present; `impeccable live-server stop` removes it. The helper writes source files, so the
  proxy admits only loopback and the addresses in `IMPECCABLE_LIVE_ALLOW` (comma-separated); add
  the remote browser's address there when working from another machine. Over plain HTTP to a LAN
  address the browser withholds `crypto.randomUUID`; the plugin supplies it.
