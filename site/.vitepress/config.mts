import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { impeccableSameOrigin } from "../../tools/impeccable-live.mts";
import { siteBase } from "../site.config.ts";
import { mermaidFamilies } from "../scripts/mermaid-pages.mts";
import { assertLandingBudget } from "../scripts/landing-budget.mts";
import { publicDirectoryIndex } from "../scripts/static-files.mts";

const siteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  title: "Archer",
  description:
    "Shared visual understanding between you and your coding agents. Local Mermaid diagrams and Markdown notes, kept with your code.",
  base: siteBase,
  buildEnd: (config) => assertLandingBudget(config.outDir),
  lang: "en-US",
  cleanUrls: true,
  // Templates that name public files use their deployed URL; Vue must not turn them into imports.
  vue: { template: { transformAssetUrls: false } },
  markdown: { theme: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" } },
  // Keep VitePress's dead-link check enabled, including generated pages.
  ignoreDeadLinks: false,
  srcExclude: ["README.md", "scripts/**"],
  vite: {
    server: { fs: { allow: [join(siteRoot, "..")] } },
    // Dev matches GitHub Pages: /playground/app/ opens the public Playground document.
    plugins: [
      publicDirectoryIndex(join(siteRoot, "public"), siteBase),
      // Dev only: Impeccable's live picker on the docs, same-origin (`impeccable live --target site`).
      impeccableSameOrigin({ serverJson: new URL("../.impeccable/live/server.json", import.meta.url), inject: true }),
    ],
    // The manifest drives the landing size budget (`scripts/landing-budget.mts`), which removes it after reading.
    build: { manifest: true },
  },
  themeConfig: {
    siteTitle: "Archer",
    // The R3-2 nav: Docs, the Playground (straight into the app, which leaves the docs), and the landing's install.
    nav: [
      {
        text: "Docs",
        link: "/install",
        activeMatch: "^/(why|how-it-works|usage|install|using-the-playground|generated/cli|supported-mermaid|security)",
      },
      { text: "Playground", link: "/playground/app/index.html" },
      { text: "Install", link: "/#install" },
    ],
    sidebar: [
      {
        text: "Start Here",
        items: [
          { text: "Install", link: "/install" },
          { text: "Why Archer", link: "/why" },
          { text: "How It Works", link: "/how-it-works" },
          { text: "Usage", link: "/usage" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/generated/cli" },
          {
            text: "Supported Mermaid",
            link: "/supported-mermaid/",
            collapsed: true,
            items: [
              { text: "Overview", link: "/supported-mermaid/" },
              ...mermaidFamilies.map((family) => ({ text: family.title, link: `/supported-mermaid/${family.slug}` })),
              { text: "Shared rules", link: "/supported-mermaid/rules" },
            ],
          },
          { text: "HTTPS & Browser Trust", link: "/security/network-access" },
        ],
      },
      { text: "Using the Playground", link: "/using-the-playground" },
    ],
    search: { provider: "local" },
    outline: { level: [2, 3], label: "On This Page" },
    socialLinks: [{ icon: "github", link: "https://github.com/chrisswanson/archer" }],
    footer: { message: "Mermaid and Markdown. Local files. Shared understanding.", copyright: "Archer · Apache-2.0" },
  },
});
