// Shared operation input validation; only the keywords used by operation schemas
// are supported. Discovery and execution consume this same schema vocabulary.
const MAX_ECHO = 32;

export interface Schema {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: Schema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export const ENFORCED = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
];
export const ANNOTATIONS = ["description", "title", "default"];

/** The most problems one refusal lists; the rest are counted. */
export const MAX_VIOLATIONS = 8;

export interface Violation {
  readonly path: string;
  readonly problem: string;
}

export class Violations {
  readonly listed: Violation[] = [];
  omitted = 0;

  push(path: string, problem: string): void {
    if (this.listed.length < MAX_VIOLATIONS) this.listed.push({ path, problem });
    else this.omitted += 1;
  }

  get empty(): boolean {
    return this.listed.length === 0;
  }

  describe(tool: string): string {
    const count = this.listed.length + this.omitted;
    let text = `${tool} rejected its arguments (${count} ${count === 1 ? "problem" : "problems"}). Nothing was done.`;
    for (const v of this.listed) text += `\n- ${v.path === "" ? v.problem : `${v.path}: ${v.problem}`}`;
    if (this.omitted > 0) text += `\n- and ${this.omitted} more`;
    return `${text}\nFix them and call again; the tool's input schema lists every argument.`;
  }
}

export function validate(schema: Schema, args: Readonly<Record<string, unknown>>): Violations {
  const violations = new Violations();
  checkObject(schema, args, "", violations);
  return violations;
}

/** Keywords in `schema` this validator does not enforce, as paths. */
export function unsupportedKeywords(schema: Schema, path = ""): string[] {
  const found: string[] = [];
  for (const [keyword, value] of Object.entries(schema)) {
    if (!ENFORCED.includes(keyword) && !ANNOTATIONS.includes(keyword)) found.push(`${path}/${keyword}`);
    if (keyword === "properties")
      for (const [name, p] of Object.entries(value as Record<string, Schema>))
        found.push(...unsupportedKeywords(p, `${path}/${name}`));
    if (keyword === "items") found.push(...unsupportedKeywords(value as Schema, `${path}[]`));
  }
  return found;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function aType(name: string): string {
  return name === "array" || name === "object" || name === "integer"
    ? `an ${name}`
    : name === "null"
      ? "null"
      : `a ${name}`;
}

function echo(value: unknown): string {
  if (typeof value === "string") {
    const chars = [...value];
    return JSON.stringify(chars.length > MAX_ECHO ? `${chars.slice(0, MAX_ECHO).join("")}…` : value);
  }
  if (typeof value === "object" && value !== null) return aType(typeName(value));
  return String(value);
}

const join = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkObject(
  schema: Schema,
  object: Readonly<Record<string, unknown>>,
  path: string,
  violations: Violations,
): void {
  const properties = schema.properties ?? {};
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(object, name)) violations.push(join(path, name), "is required and was not given");
  }
  for (const [key, value] of Object.entries(object)) {
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (property !== undefined) checkValue(property, value, join(path, key), violations);
    else if (schema.additionalProperties === false) {
      const accepted = Object.keys(properties);
      violations.push(
        join(path, echo(key)),
        `is not an argument this tool defines; ${accepted.length === 0 ? "no arguments are accepted here" : `the accepted names are ${accepted.join(", ")}`}`,
      );
    }
  }
}

function checkValue(schema: Schema, value: unknown, path: string, violations: Violations): void {
  if (schema.type !== undefined) {
    const actual = typeName(value);
    const types: readonly string[] = typeof schema.type === "string" ? [schema.type] : schema.type;
    const matches = types.some((type) =>
      type === "number" ? actual === "number" || actual === "integer" : type === actual,
    );
    if (!matches) {
      violations.push(
        path,
        `must be ${types.map(aType).join(" or ")}, and is ${aType(actual === "integer" ? "number" : actual)}`,
      );
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(
      path,
      `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}, and is ${echo(value)}`,
    );
    return;
  }
  if (Object.hasOwn(schema, "const") && schema.const !== value) {
    violations.push(path, `must be ${JSON.stringify(schema.const)}, and is ${echo(value)}`);
    return;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength)
      violations.push(
        path,
        schema.minLength === 1
          ? "must not be empty"
          : `must be at least ${schema.minLength} characters, and is ${length}`,
      );
    if (schema.maxLength !== undefined && length > schema.maxLength)
      violations.push(path, `must be at most ${schema.maxLength} characters, and is ${length}`);
  } else if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      violations.push(path, `must be at least ${schema.minimum}, and is ${value}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      violations.push(path, `must be at most ${schema.maximum}, and is ${value}`);
  } else if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      violations.push(path, `must hold at least ${schema.minItems} items, and holds ${value.length}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      violations.push(path, `must hold at most ${schema.maxItems} items, and holds ${value.length}`);
      return;
    }
    if (schema.items !== undefined)
      value.forEach((item, i) => checkValue(schema.items as Schema, item, `${path}[${i}]`, violations));
  } else if (isObject(value)) checkObject(schema, value, path, violations);
}
