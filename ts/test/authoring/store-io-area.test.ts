import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { withChangeStoreIo } from "../../src/changes/io.ts";
test("authoring runtime area is isolated and the default change-review area is unchanged", () => {
  const state = realpathSync(mkdtempSync(join(tmpdir(), "authoring-area-")));
  chmodSync(state, 0o700);
  try {
    withChangeStoreIo(state, (io) => io.replaceIndex(Buffer.from("changes")));
    withChangeStoreIo(state, (io) => io.replaceIndex(Buffer.from("authoring")), "authoring");
    expect(readFileSync(join(state, "runtime/change-review/index.json"), "utf8")).toBe("changes");
    expect(readFileSync(join(state, "runtime/authoring/index.json"), "utf8")).toBe("authoring");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
test.each(["../other", "/tmp/other", "authoring/../other", "", "change-review/extra"])(
  "runtime area %j refuses before any filesystem change",
  (area) => {
    const state = realpathSync(mkdtempSync(join(tmpdir(), "authoring-area-invalid-")));
    chmodSync(state, 0o700);
    try {
      expect(() => withChangeStoreIo(state, () => {}, area as never)).toThrow("unknown private store area");
      expect(existsSync(join(state, "runtime"))).toBe(false);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  },
);
