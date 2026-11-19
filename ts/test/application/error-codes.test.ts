import { expect, test } from "vitest";
import { ERROR_CODES } from "../../src/application/errors.ts";

test("a diagram with no compiled drawing answers MCP clients as not found, as it did before it had its own code", () => {
  // Clients branch on the JSON-RPC number: a view that has never compiled has no drawing to give,
  // as a missing one has none. The code string says which; the number stays what clients know.
  expect(ERROR_CODES.diagram_not_compiled).toBe(ERROR_CODES.diagram_not_found);
  expect(ERROR_CODES.diagram_not_found).toBe(-32002);
});
