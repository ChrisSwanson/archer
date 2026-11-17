import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Bundles place workers beside the entry point; source runs keep their local filename. */
export function workerLocation(moduleUrl: string, filename: string, source = `${filename}.ts`): URL | null {
  for (const path of [`./${filename}.js`, `../${filename}.js`, `./${source}`]) {
    const url = new URL(path, moduleUrl);
    if (existsSync(fileURLToPath(url))) return url;
  }
  return null;
}

/** Register the development loader inside the worker before its TypeScript entry is imported. */
export function workerModule(url: URL): URL {
  if (!url.pathname.endsWith(".ts")) return url;
  // --input-type is inherited too: Node accepts it for a data URL, but refuses a file entry.
  const inputType = process.execArgv.some((flag) => flag === "--input-type" || flag.startsWith("--input-type="));
  if (!inputType && process.execArgv.some((flag) => flag.includes("tsx"))) return url;
  const api = createRequire(import.meta.url).resolve("tsx/esm/api");
  const source = `import { register } from ${JSON.stringify(pathToFileURL(api).href)}; register(); await import(${JSON.stringify(url.href)});`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}
