// Reading Mermaid's internal databases, whose types Mermaid does not publish
// (research 01): every value is checked as it is read, and a shape Archer does
// not know fails loudly, naming the pinned version as the suspect.

export type Fields = Record<string, unknown>;

export function drift(database: string, what: string): Error {
  return new Error(
    `Mermaid's ${database} database is not the shape Archer reads (${what}); check the pinned mermaid version`,
  );
}

export function fields(value: unknown, database: string, what: string): Fields {
  if (typeof value !== "object" || value === null) throw drift(database, what);
  return value as Fields;
}

/** Call the database's zero-argument getter `name`. */
export function call(db: Fields, database: string, name: string): unknown {
  const method = db[name];
  if (typeof method !== "function") throw drift(database, `no ${name}()`);
  return (method as (this: unknown) => unknown).call(db);
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
