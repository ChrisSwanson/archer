// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from "vitest";
import { packSnapshot, type PlaygroundIndex } from "../../shared/playground-delivery.mts";
import { exampleSnapshot } from "./support/playground-snapshot";
let snapshot: ReturnType<typeof exampleSnapshot>;
let index: PlaygroundIndex;
const files = new Map<string, string>();
beforeAll(() => {
  snapshot = exampleSnapshot();
  const packed = packSnapshot(snapshot);
  files.set("data/shared.json", JSON.stringify(packed.shared));
  snapshot.projects.forEach((project, position) =>
    files.set(`data/${project.slug}.json`, JSON.stringify(packed.projects[position])),
  );
  index = {
    formatVersion: 1,
    manifest: snapshot.manifest,
    fontLicense: snapshot.fontLicense,
    shared: "data/shared.json",
    projects: snapshot.projects.map((project) => ({
      slug: project.slug,
      name: project.name,
      ...(project.notice ? { notice: project.notice } : {}),
      data: `data/${project.slug}.json`,
    })),
  };
}, 30000);

/** The published files beside the document, and the paths the boot asked for. */
function publish(base: string) {
  const requested: string[] = [];
  const payload = document.createElement("script");
  payload.id = "archer-playground-index";
  payload.type = "application/json";
  payload.textContent = JSON.stringify(index);
  document.body.replaceChildren(payload);
  const fetcher = (async (input: URL) => {
    const path = input.pathname.slice(`${base}playground/app/`.length);
    requested.push(path);
    const body = files.get(path);
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  }) as unknown as typeof fetch;
  return { requested, fetcher };
}

it.each(["/", "/archer/"])(
  "canonicalizes a directory route without losing its query or fragment at %s",
  async (base) => {
    vi.resetModules();
    const { fetcher } = publish(base);
    const query = "?route=%2Fprojects%2Farcher-tour%2Fdiagrams%2Fcontainers.mmd&scene=hero#demo";
    window.history.replaceState(null, "", `${base}playground/app/${query}`);
    await (await import("../src/playground/boot")).bootPlayground(fetcher);
    expect(window.location.pathname).toBe(`${base}playground/app/index.html`);
    expect(window.location.search).toBe(query.slice(0, query.indexOf("#")));
    expect(window.location.hash).toBe("#demo");
  },
);

it("retains compact-scene activation when opening a bare document, and loads only the Tour", async () => {
  vi.resetModules();
  const { requested, fetcher } = publish("/archer/");
  window.history.replaceState(null, "", "/archer/playground/app/index.html?scene=hero");
  const boot = await (await import("../src/playground/boot")).bootPlayground(fetcher);
  expect(new URL(window.location.href).searchParams.get("scene")).toBe("hero");
  expect(new URL(window.location.href).searchParams.get("route")).toBe("/projects/archer-tour/diagrams/containers.mmd");
  expect(requested.sort()).toEqual(["data/archer-tour.json", "data/shared.json"]);
  expect(boot.snapshot.projects.map((project) => project.slug)).toEqual(["archer-tour"]);
  expect(boot.snapshot.projects[0]).toEqual(snapshot.projects.find((project) => project.slug === "archer-tour"));
});

it("keeps the compact scene on the Tour diagram and walkthrough step its address names", async () => {
  vi.resetModules();
  const { fetcher } = publish("/archer/");
  const query =
    "?route=%2Fprojects%2Farcher-tour%2Fdiagrams%2Fheartbeat.mmd&walkthrough=one-turn&step=5&scene=hero&theme=dark";
  window.history.replaceState(null, "", `/archer/playground/app/index.html${query}`);
  await (await import("../src/playground/boot")).bootPlayground(fetcher);
  const address = new URL(window.location.href).searchParams;
  expect(address.get("route")).toBe("/projects/archer-tour/diagrams/heartbeat.mmd");
  expect([address.get("walkthrough"), address.get("step"), address.get("scene")]).toEqual(["one-turn", "5", "hero"]);
  // Another project's route still opens the Tour's containers: the scene shows only the Tour.
  vi.resetModules();
  window.history.replaceState(
    null,
    "",
    "/archer/playground/app/index.html?route=%2Fprojects%2Frfc-1149-ipoac%2Fdiagrams%2Fx.mmd&scene=hero",
  );
  await (await import("../src/playground/boot")).bootPlayground(fetcher);
  expect(new URL(window.location.href).searchParams.get("route")).toBe("/projects/archer-tour/diagrams/containers.mmd");
});

it("loads the routed project's data and selects the static runtime and address codec before mounting", async () => {
  vi.resetModules();
  const { requested, fetcher } = publish("/");
  window.history.replaceState(null, "", "/playground/app/index.html?route=%2Fprojects%2Frfc-1149-ipoac%2F");
  const { bootPlayground } = await import("../src/playground/boot");
  const boot = await bootPlayground(fetcher);
  expect(requested.sort()).toEqual(["data/rfc-1149-ipoac.json", "data/shared.json"]);
  const { runtime } = await import("../src/app/runtime");
  const { encodeAddress, browserStateKey } = await import("../src/runtime/address");
  expect(runtime).toBe(boot.runtime);
  expect(runtime.features.authoring).toBe(false);
  expect(encodeAddress("/projects/rfc-1149-ipoac/")).toBe(
    "http://localhost:3000/playground/app/index.html?route=%2Fprojects%2Frfc-1149-ipoac%2F",
  );
  expect(browserStateKey("theme")).toBe(`archer:playground:${snapshot.manifest.digest}:theme`);
});
