import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("repeated table headers within the manifest byte limit complete against a clock", () => {
  const parser = new URL("../../src/project/toml.ts", import.meta.url).href;
  const script = `import { parseToml } from ${JSON.stringify(parser)};
    const document = parseToml('[[services]]\\n'.repeat(80_000));
    if (document.services.length !== 80_000) throw new Error('table inventory lost');
    process.stdout.write('bounded tables');`;
  const result = spawnSync(
    process.execPath,
    ["--stack_size=256", "--import", "tsx", "--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("bounded tables");
}, 15_000);
