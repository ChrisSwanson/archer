import { afterEach, expect, test } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { project, cleanUp } from "./support.ts";
afterEach(cleanUp);
test("browser inventory keeps exact registered source paths for navigation, independently of view IDs", async () => {
  const root = project();
  const state = await ProjectState.open(
    root,
    (slug) => `http://x/${slug}/`,
    () => {},
  );
  const views = state.inventory().views as unknown as Record<string, unknown>[];
  expect(views.find((v) => v.id === "flow")?.sourcePath).toBe("flow.mmd");
  expect(views.find((v) => v.id === "chat")?.sourcePath).toBe("chat.mmd");
  await state.close();
});
