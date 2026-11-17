/** Narrow page operation surface; execution delegates the shared application registry. */
export const BROWSER_OPERATIONS = [
  "list_stale_diagrams",
  "read_diagram_at_commit",
  "compare_diagrams",
  "export_diagram",
] as const;
export type BrowserOperationName = (typeof BROWSER_OPERATIONS)[number];
export class BrowserOperationRefusal extends Error {
  readonly code = "invalid_request";
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function parseBrowserOperation(value: unknown): {
  name: BrowserOperationName;
  arguments: Record<string, unknown>;
} {
  if (
    !object(value) ||
    typeof value["name"] !== "string" ||
    !(BROWSER_OPERATIONS as readonly string[]).includes(value["name"]) ||
    !object(value["arguments"]) ||
    Object.keys(value).some((key) => key !== "name" && key !== "arguments")
  )
    throw new BrowserOperationRefusal("The page supports accuracy and export operations with named arguments only.");
  const pending = [{ value: value["arguments"] as unknown, depth: 0 }];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++visited > 10_000 || item.depth > 32)
      throw new BrowserOperationRefusal("Page operation arguments exceed their value or depth limit.");
    if (item.value !== null && typeof item.value === "object") {
      if (seen.has(item.value))
        throw new BrowserOperationRefusal("Page operation arguments must be an acyclic JSON value.");
      seen.add(item.value);
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return { name: value["name"] as BrowserOperationName, arguments: value["arguments"] };
}
