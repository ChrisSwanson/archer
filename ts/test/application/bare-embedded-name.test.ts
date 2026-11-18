// A diagram inside a note is the view <note path>#<name>. `archer draw` also accepts its bare name; the
// tools do not, and used to say only that no view had that name. They now name the address to use.
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

const NOTE = "# Flow\n\n```mermaid\n%% archer-id: payment\nflowchart LR\n  a[A] e1@--> b[B]\n```\n";

test("a bare name of a diagram inside a note is refused with the note address to use", async () => {
  const root = tempDir({ "archer.toml": "version = 1\n", ".archer/notes/multi.md": NOTE });
  const app = createApplication({ cwd: root });
  try {
    await expect(app.call("read_diagram", { viewId: "payment" })).rejects.toThrow(
      /Did you mean notes\/multi\.md#payment/,
    );
    await expect(app.call("read_diagram", { viewId: "notes/multi.md#payment" })).resolves.toBeDefined();
  } finally {
    app.close();
  }
});
