import { expect, it } from "vitest";
import { createStaticRuntime } from "../src/playground/runtime";
import type { PlaygroundSnapshot } from "../../shared/playground-snapshot.mts";
it("turns an allowlisted thumbnail into image data and never exposes API image URLs", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Real generated asset</text></svg>';
  const snapshot = {
    formatVersion: 1,
    manifest: { digest: "sha256:test" },
    projects: [{ slug: "tour", name: "Tour", responses: { "api/thumbnails/view?theme=light": svg } }],
  } as unknown as PlaygroundSnapshot;
  const local = createStaticRuntime({ snapshot, href: () => "https://demo.test/projects/tour/", storage: null });
  expect(local.resourceUrl?.("https://demo.test/p/tour/api/thumbnails/view?rev=x&theme=light")).toBe(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  );
  expect(local.resourceUrl?.("https://evil.test/p/tour/api/thumbnails/view?theme=light")).toBeNull();
  expect((await local.request("api/thumbnails/view?theme=light")).headers.get("content-type")).toContain(
    "image/svg+xml",
  );
});
