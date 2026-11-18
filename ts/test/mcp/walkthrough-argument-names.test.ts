// A refusal that lists the names a tool accepts lists every one, including the argument the tool parses itself.
import { afterEach, expect, test } from "vitest";
import { connect, refusal, removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

test("write_walkthrough's unknown-argument refusal names walkthrough among the accepted names", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  const error = await refusal(client, "write_walkthrough", { viewId: "v", steps: [] });
  expect(error.data.code).toBe("invalid_arguments");
  expect(error.message).toMatch(/accepted names are [^\n]*\bwalkthrough\b/);
  await close();
});
