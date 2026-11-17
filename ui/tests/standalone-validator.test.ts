import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../schema/diagram-envelope.schema.json";
import type { ValidateFunction } from "ajv";

const generated = new URL("../src/protocol/envelope-validator.generated.cjs", import.meta.url);
const module = { exports: {} as unknown };
// Execute the exact checked-in production validator with Function/eval disabled.
runInNewContext(
  readFileSync(generated, "utf8"),
  { module, exports: module.exports, require: createRequire(generated) },
  { contextCodeGeneration: { strings: false, wasm: false } },
);
const standalone = module.exports as ValidateFunction;
const authoritative = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

for (const category of ["valid", "invalid"]) {
  const directory = new URL(`../../fixtures/protocol/${category}/`, import.meta.url);
  test.each(readdirSync(directory).filter((name) => name.endsWith(".json")))(
    `static schema validator agrees with authoritative AJV: ${category}/%s`,
    (filename) => {
      const input = JSON.parse(readFileSync(new URL(filename, directory), "utf8"));
      expect(standalone(input)).toBe(authoritative(input));
      expect(JSON.parse(JSON.stringify(standalone.errors))).toEqual(JSON.parse(JSON.stringify(authoritative.errors)));
    },
  );
}
