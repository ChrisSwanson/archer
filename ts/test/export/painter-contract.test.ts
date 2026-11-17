import { test, expect } from "vitest";
import { paintExport } from "@archer/export-painter";
// The ambient seam must preserve concrete neutral types, even with skipLibCheck.
type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;
type CheckedResult = Assert<IsAny<Awaited<ReturnType<typeof paintExport>>> extends false ? true : false>;
test("neutral painter refuses invalid models through its production validation", async () => {
  await expect(paintExport({ envelope: {}, mode: "diagram" })).rejects.toThrow("export_invalid_envelope");
});
