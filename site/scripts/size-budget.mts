import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** The part of Vite's `build.manifest` a budget reads. */
export interface ManifestChunk {
  readonly file: string;
  readonly name?: string;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
}
export type BuildManifest = Readonly<Record<string, ManifestChunk>>;

/** What a browser fetches to start one view: manifest chunks with their static imports and CSS, plus other files. */
export interface EntryBudget {
  readonly chunks: readonly string[];
  readonly files?: readonly string[];
  readonly limit: number;
}

/**
 * Gzip-9 byte limits for a build, read from its manifest rather than pinned to a past commit:
 * `entries` caps what a browser fetches to start each named view, `chunk` caps any one emitted JS or CSS
 * file, and `files` caps other published files by path prefix.
 */
export interface SizeBudget {
  readonly entries: Readonly<Record<string, EntryBudget>>;
  readonly chunk: number;
  readonly files?: Readonly<Record<string, number>>;
}

/** Files fetched to start the chunks named by `keys` (not their dynamic imports), each once. */
export function entryFiles(manifest: BuildManifest, ...keys: string[]): string[] {
  const files = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const chunk = manifest[name];
    if (!chunk) throw new Error(`The build manifest has no chunk ${name}.`);
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const key of keys) visit(key);
  return [...files];
}

/** The manifest key of the entry chunk Vite named `name` (VitePress's app entry sits under node_modules). */
export function entryNamed(manifest: BuildManifest, name: string): string {
  const key = Object.keys(manifest).find((key) => manifest[key]!.isEntry && manifest[key]!.name === name);
  if (!key) throw new Error(`The build manifest has no entry named ${name}.`);
  return key;
}

const gzip = async (root: string, file: string): Promise<number> =>
  gzipSync(await readFile(join(root, file)), { level: 9 }).length;

export interface SizeReport {
  readonly entries: Readonly<Record<string, number>>;
  readonly chunks: Readonly<Record<string, number>>;
  readonly files: Readonly<Record<string, number>>;
}

export async function measureBuild(
  root: string,
  manifest: BuildManifest,
  budget: SizeBudget,
  published: readonly string[] = [],
): Promise<SizeReport> {
  const sizes = new Map<string, number>();
  const size = async (file: string) => {
    if (!sizes.has(file)) sizes.set(file, await gzip(root, file));
    return sizes.get(file)!;
  };
  const entries: Record<string, number> = {};
  for (const [name, entry] of Object.entries(budget.entries)) {
    let total = 0;
    for (const file of new Set([...entryFiles(manifest, ...entry.chunks), ...(entry.files ?? [])]))
      total += await size(file);
    entries[name] = total;
  }
  const chunks: Record<string, number> = {};
  for (const chunk of Object.values(manifest))
    for (const file of [chunk.file, ...(chunk.css ?? [])])
      if (/\.(?:js|css)$/.test(file)) chunks[file] = await size(file);
  const files: Record<string, number> = {};
  for (const file of published) files[file] = await size(file);
  return { entries, chunks, files };
}

export function budgetViolations(report: SizeReport, budget: SizeBudget): string[] {
  const violations: string[] = [];
  for (const [name, { limit }] of Object.entries(budget.entries))
    if (report.entries[name]! > limit) violations.push(`entry ${name}: ${report.entries[name]} gzip bytes > ${limit}`);
  for (const [file, bytes] of Object.entries(report.chunks))
    if (bytes > budget.chunk) violations.push(`chunk ${file}: ${bytes} gzip bytes > ${budget.chunk}`);
  for (const [file, bytes] of Object.entries(report.files)) {
    const rule = Object.entries(budget.files ?? {}).find(([prefix]) => file.startsWith(prefix));
    if (rule && bytes > rule[1]) violations.push(`file ${file}: ${bytes} gzip bytes > ${rule[1]}`);
  }
  return violations;
}

export async function assertSizeBudget(
  label: string,
  root: string,
  manifest: BuildManifest,
  budget: SizeBudget,
  published: readonly string[] = [],
): Promise<SizeReport> {
  const report = await measureBuild(root, manifest, budget, published);
  const violations = budgetViolations(report, budget);
  if (violations.length > 0) throw new Error(`${label} exceeds its size budget:\n${violations.join("\n")}`);
  console.info(
    `${label}: ${Object.entries(report.entries)
      .map(([name, bytes]) => `${name} ${bytes}/${budget.entries[name]!.limit}`)
      .join(", ")} gzip bytes; largest chunk ${Math.max(...Object.values(report.chunks))}/${budget.chunk}.`,
  );
  return report;
}

/** Read and remove a build's `.vite/manifest.json`: it is build evidence, not a published file. */
export async function takeManifest(outDir: string): Promise<BuildManifest> {
  const path = join(outDir, ".vite/manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as BuildManifest;
  await rm(join(outDir, ".vite"), { recursive: true, force: true });
  return manifest;
}
