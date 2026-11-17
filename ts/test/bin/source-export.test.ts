import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { isolatedProcessEnv, cleanUp, project, tempDir, write } from "../service/support.ts";
afterEach(cleanUp);

test.each([
  ["flowchart", "freeform"],
  ["state", "state"],
  ["er", "entity-relationship"],
  ["c4", "c4"],
  ["architecture", "architecture"],
  ["sequence", "sequence"],
  ["journey", "journey"],
])(
  "source CLI %s loads the same painter independently of caller JSX config",
  (family, kind) => {
    const root = project();
    write(
      root,
      "archer.toml",
      `version = 1\n[[views]]\nid = "flow"\nkind = "${kind}"\ntitle = "Source export"\nsource = ".archer/flow.mmd"\n`,
    );
    write(
      root,
      ".archer/flow.mmd",
      readFileSync(new URL(`../fixtures/${family}/widened.mmd`, import.meta.url), "utf8"),
    );
    const args = write(root, "export.json", JSON.stringify({ viewId: "flow", format: "png", mode: "presentation" }));
    const entry = fileURLToPath(new URL("../../src/bin/archer.ts", import.meta.url));
    const loader = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", loader, entry, "call", "export_diagram", "--file", args, "--json"],
      {
        cwd: root,
        env: isolatedProcessEnv(root, {
          ARCHER_STATE_DIR: tempDir(),
          ARCHER_SOCKET: root + "/absent.sock",
          ARCHER_AUTO_START: "false",
          ARCHER_OPEN_BROWSER: "never",
        }),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const artifact = JSON.parse(result.stdout);
    expect(artifact.mimeType).toBe("image/png");
    expect(Buffer.from(artifact.data, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  },
  30_000,
);
