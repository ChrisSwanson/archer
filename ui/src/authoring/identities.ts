/** One readable identity allocator; existing IDs are never renamed. */
export function nextFreeId(prefix: "n" | "e", taken: Iterable<string>): string {
  const ids = new Set(taken);
  let n = 1;
  while (ids.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
