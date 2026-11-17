# Archer Documentation Site

VitePress 1.6.4, with the default theme adapted to Archer's Fira Sans typography and cool slate palette. The examples are shown in the static [Playground](using-the-playground.md) (the app itself is published at `playground/app/`), built by `scripts/playground-build.mts`; no service runs.

```sh
npm run docs:dev
npm run docs:build
npm run docs:preview -- --host 127.0.0.1 --port 4173
npm run docs:test:browser
node --import tsx site/scripts/references-check.mjs
npm --workspace ts test -- test/site
```

The build output is `site/.vitepress/dist`. `ARCHER_DOCS_BASE` overrides the default `/archer/`; set it for both build and browser checks. For example, `ARCHER_DOCS_BASE=/ npm run docs:build` targets a custom domain's root.

## Content

- `index.md`, `why.md`, `how-it-works.md` and `usage.md` introduce the product and its workflows.
- `scripts/prepare.ts` copies Install from `docs/install.md` and HTTPS & Browser Trust from `docs/tls.md`. It splits the complete agent-facing `ts/docs/supported-mermaid.md` into an overview, seven family references and shared rules. Generated copies are ignored. Edit the canonical files. Links between published sources stay within the site; maintainer links go to the public repository. Security policy and known limits remain repository documents and are not published as site pages.
- `scripts/cli-reference.mts` generates the CLI reference from runtime and packaged CLI synopses and option declarations, with short editorial purposes, option explanations and examples. Tests compare help, dispatch, parser declarations and package flags against the result, and compile it through VitePress and Vue. Agent-facing `archer docs cli` keeps its complete operational guidance.
- `scripts/playground-bridges.mts` keeps the retired Examples gallery's addresses (`/generated/examples/…`). It lists the Playground's three projects with Archer's project loader, without compiling them, and writes one small page per old project, diagram and note page. Each redirects at once to the matching Playground route, encoded by the Playground's own address encoder, and keeps a visible “Open in Playground” link. Each RFC project's complete `NOTICE.md` is also published as its own notice page, which the Playground page links.

## Machine-readable docs

Every prepare/build writes `public/llms.txt` and `public/llms-full.txt`, served under the deployment base (`/archer/` by default). `scripts/documents.mts` admits the guide pages; the CLI and Mermaid generators supply their reference pages. Each index entry has a one-line summary. The full file contains the same guide/reference Markdown, with presentation wrappers removed and links made absolute. Example projects are linked in a short directory; their RFC transcripts are outside the reference bundle.

We evaluated [vitepress-plugin-llms](https://github.com/okineadev/vitepress-plugin-llms), which generates the two files and offers per-page Markdown and UI controls. A small prepare step fits this site: the canonical Markdown is already available before VitePress, the admission list is explicit, and large example artifacts need a different treatment from guides. It adds no dependency or theme integration. Tests cover base paths, source links, code preservation, summaries, duplicate routes and actual prepared output.

```sh
npm --workspace ts test -- --configLoader runner test/site
shellcheck -s sh site/public/install.sh
```

`references-check.mjs` checks the 15 guide/reference pages in Chromium at desktop and phone widths, in both themes, with axe, keyboard disclosure, links and public-file checks. `--static` checks served HTML, anchors and artifacts without claiming layout or accessibility coverage.

The installer is a public source file, not generated. It downloads `archer.tgz` plus `SHA256SUMS` from the latest GitHub Release; `ARCHER_VERSION` selects a tag and `ARCHER_RELEASE_BASE` overrides the download directory for local tests. The public release workflow publishes stable and versioned package names with checksums for both. The unit test executes that workflow's checksum block and the real installer against a local release directory.

## GitHub Pages

The public export includes `site/`. Its Pages workflow comes from `scripts/oss-export.overlay/.github/workflows/pages.yml`; it runs on main and manual dispatch, installs the lockfile dependencies, builds the site, uploads the Pages artifact and deploys it. The build imports source modules, so it needs no separate application bundle. Only the deployment job receives Pages and OIDC write permissions. Enable GitHub Actions as the repository's Pages source before the first deployment.

`npm run docs:test:browser` runs the Playwright specs under `tests/` against the built site (`ARCHER_DOCS_DIST`, default `site/.vitepress/dist`) through `tests/serve-static.ts`, which serves it as GitHub Pages does. `tests/theme` covers the outline disclosure, the landing at desktop and phone widths in both themes (fit, install command above the fold, only the active theme's app picture downloaded), the install tabs and the Diagram Key tour; `tests/playground` covers the live hero and the old Examples addresses. In `docs:dev`, `scripts/static-files.mts` serves a public directory's `index.html` for its own address, so `/playground/app/` opens there too.
