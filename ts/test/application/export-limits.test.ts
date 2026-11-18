// An export over the size limit says what the limits are and what to change; a diagram-mode export
// says that highlights are drawn only in presentation mode.
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanUp, project, write } from "../service/support.ts";

afterEach(cleanUp);

const chain = (n: number): string =>
  `flowchart LR\n  n0[Step 0]\n${Array.from({ length: n }, (_, i) => `  n${i} e${i}@--> n${i + 1}[Step ${i + 1}]`).join("\n")}\n`;

function open() {
  const root = project();
  write(root, ".archer/flow.mmd", chain(400));
  return createApplication({ cwd: root, findService: async () => null, env: { ARCHER_AUTO_START: "0" } });
}

test("an export over the size limit names the limits, the size, and the scale to pass", async () => {
  const app = open();
  try {
    const failure = await app.call("export_diagram", { viewId: "flow", format: "png" }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("16,000 px a side");
    expect(message).toContain("32 million pixels");
    expect(message).toMatch(/`scale`/);
    expect(message).toMatch(/scale of 0?\.\d+ /);
  } finally {
    app.close();
  }
});

test("a diagram-mode export says highlights are drawn only in presentation mode", async () => {
  const root = project();
  const app = createApplication({ cwd: root, findService: async () => null, env: { ARCHER_AUTO_START: "0" } });
  try {
    const diagram = await app.call("export_diagram", { viewId: "flow" });
    expect(diagram.text).toMatch(/Highlights are drawn only with mode "presentation"/);
    const presentation = await app.call("export_diagram", { viewId: "flow", mode: "presentation" });
    expect(presentation.text).not.toMatch(/Highlights are drawn only/);
  } finally {
    app.close();
  }
});
