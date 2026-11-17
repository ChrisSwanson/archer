// A checker for the subset of JSON Schema that schema/diagram-envelope.schema.json
// uses, so a test can hold a compiled model to the wire contract without a
// validator dependency. It refuses a keyword it does not know rather than
// skipping it, so the schema cannot grow past what is checked.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Schema = { [keyword: string]: unknown };

const SCHEMA_PATH = fileURLToPath(new URL("../../../../schema/diagram-envelope.schema.json", import.meta.url));

export const envelopeSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Schema;

const KNOWN = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "properties",
  "additionalProperties",
  "required",
  "$defs",
  "$ref",
  "oneOf",
  "anyOf",
  "enum",
  "const",
  "items",
  "pattern",
  "maxLength",
  "minLength",
  "minimum",
  "maximum",
]);

function definition(name: string): Schema {
  const defs = envelopeSchema["$defs"] as Record<string, Schema>;
  const found = defs[name];
  if (found === undefined) throw new Error(`no $defs/${name}`);
  return found;
}

/** Problems with `value` against `$defs/<name>`, as `path: problem` lines; empty when it conforms. */
export function checkAgainst(name: string, value: unknown): string[] {
  return check(definition(name), value, "$");
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function check(schema: Schema, value: unknown, path: string): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) throw new Error(`schema keyword ${keyword} is not checked`);
  }
  const ref = schema["$ref"];
  if (typeof ref === "string") return check(definition(ref.replace("#/$defs/", "")), value, path);
  const oneOf = schema["oneOf"] as Schema[] | undefined;
  if (oneOf) {
    const passing = oneOf.filter((option) => check(option, value, path).length === 0).length;
    return passing === 1 ? [] : [`${path}: matches ${passing} of oneOf`];
  }
  const anyOf = schema["anyOf"] as Schema[] | undefined;
  const problems: string[] = [];
  // anyOf is one keyword among its siblings (a type or maxLength beside it still applies).
  if (anyOf && !anyOf.some((option) => check(option, value, path).length === 0))
    problems.push(`${path}: matches no anyOf`);
  const type = schema["type"];
  if (type !== undefined) {
    const allowed = Array.isArray(type) ? (type as string[]) : [type as string];
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === "integer" && allowed.includes("number"))) {
      return [`${path}: ${actual} is not ${allowed.join("|")}`];
    }
  }
  if ("const" in schema && schema["const"] !== value) problems.push(`${path}: not ${String(schema["const"])}`);
  const enumeration = schema["enum"] as unknown[] | undefined;
  if (enumeration && !enumeration.includes(value)) problems.push(`${path}: ${String(value)} not in enum`);
  if (typeof value === "string") {
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value))
      problems.push(`${path}: fails ${pattern}`);
    const max = schema["maxLength"];
    if (typeof max === "number" && [...value].length > max) problems.push(`${path}: longer than ${max}`);
    const min = schema["minLength"];
    if (typeof min === "number" && [...value].length < min) problems.push(`${path}: shorter than ${min}`);
  }
  if (typeof value === "number") {
    const minimum = schema["minimum"];
    const maximum = schema["maximum"];
    if (typeof minimum === "number" && value < minimum) problems.push(`${path}: below ${minimum}`);
    if (typeof maximum === "number" && value > maximum) problems.push(`${path}: above ${maximum}`);
  }
  if (Array.isArray(value) && schema["items"]) {
    value.forEach((item, index) => problems.push(...check(schema["items"] as Schema, item, `${path}[${index}]`)));
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = (schema["properties"] ?? {}) as Record<string, Schema>;
    for (const key of (schema["required"] ?? []) as string[]) {
      if (!(key in record)) problems.push(`${path}: missing ${key}`);
    }
    for (const [key, item] of Object.entries(record)) {
      const property = properties[key];
      if (property) problems.push(...check(property, item, `${path}.${key}`));
      else if (schema["additionalProperties"] === false) problems.push(`${path}: unexpected ${key}`);
    }
  }
  return problems;
}
