import { assertSizeBudget, entryNamed, takeManifest, type BuildManifest, type SizeBudget } from "./size-budget.mts";

/**
 * The docs landing before activation: its HTML, VitePress's app entry, the landing page chunk and the site
 * stylesheet, each with its static imports. Fonts, posters and lazy imports are outside this code budget.
 * Limits are absolute gzip-9 bytes from the build manifest (2026-11-13: landing 101.6 KB, largest chunk 45.7 KB).
 */
export function landingBudget(manifest: BuildManifest): SizeBudget {
  return {
    entries: {
      landing: {
        chunks: [entryNamed(manifest, "app"), "index.md", "style.css"],
        files: ["index.html"],
        limit: 120 * 1024,
      },
    },
    chunk: 64 * 1024,
  };
}

export async function assertLandingBudget(outDir: string): Promise<void> {
  const manifest = await takeManifest(outDir);
  await assertSizeBudget("Landing", outDir, manifest, landingBudget(manifest));
}
