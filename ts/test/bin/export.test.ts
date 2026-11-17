import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main, type Io } from "../../src/bin/main.ts";
import { cleanUp, project, tempDir } from "../service/support.ts";
afterEach(cleanUp);

test("CLI export writes actual bytes atomically without printing the payload", async () => {
  const root = project(),
    output = join(tempDir(), "diagram image.svg");
  let out = "",
    err = "";
  const io: Io & { stdin: () => Promise<string> } = {
    cwd: root,
    env: { ARCHER_STATE_DIR: tempDir(), ARCHER_OPEN_BROWSER: "never" },
    isTTY: false,
    columns: undefined,
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    stdin: async () => JSON.stringify({ viewId: "flow", format: "svg", theme: "light" }),
  };
  expect(await main(["call", "export_diagram", "--stdin", "--output", output, "--json"], io), err).toBe(0);
  const result = JSON.parse(out);
  expect(result).toMatchObject({ outputPath: output, mimeType: "image/svg+xml", lastGood: false });
  expect(result.data).toBeUndefined();
  expect(readFileSync(output, "utf8")).toContain("Client");
  expect(out).not.toContain("<svg");
});

test("CLI --output cannot be attached to a mutation or unrelated operation", async () => {
  const root = project(),
    output = join(tempDir(), "unexpected.json");
  let err = "";
  const io: Io = {
    cwd: root,
    env: {},
    isTTY: false,
    columns: undefined,
    stdout: () => {},
    stderr: (text) => (err += text),
  };
  expect(await main(["call", "list_diagrams", "--output", output], io)).toBe(2);
  expect(err).toContain("export_diagram");
  expect(existsSync(output)).toBe(false);
});
