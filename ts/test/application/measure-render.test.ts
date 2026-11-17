import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { renderOperation } from "../../src/application/render.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test("readable validation keeps the complete namespaced layout review separate from rename suggestions", async () => {
  const app = createApplication({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  try {
    const validated = await app.call("validate_diagram", { viewId: "flow", source: FLOW });
    expect(validated.structured.valid).toBe(true);
    expect(validated.structured).toHaveProperty("layoutReview");
    const rendered = renderOperation("validate_diagram", validated);
    expect(rendered).toContain("layoutReview ");
    expect(rendered).toContain("sourceRevision=");
    expect(rendered).toContain("valid true");
  } finally {
    app.close();
  }
});
