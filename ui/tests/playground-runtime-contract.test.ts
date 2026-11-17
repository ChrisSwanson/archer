import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseInventory } from "../src/app/inventory";
import { runtime as liveRuntime } from "../src/app/runtime";
import { validateEnvelope } from "../src/protocol/validate";
import { createStaticRuntime } from "../src/playground/runtime";
import { exampleSnapshot } from "./support/playground-snapshot";
import { signInCookie, startTsProject, type TsProject } from "./support/ts-service";

/** The same real example is compiled by snapshot generation and a separately running live service. */
function tourFiles(): Record<string, string> {
  const root = resolve(import.meta.dirname, "../../examples/archer-tour");
  const files: Record<string, string> = {};
  const visit = (folder: string): void => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[path] = readFileSync(join(root, path), "utf8");
      else throw new Error(`Example source must be a plain file: ${path}`);
    }
  };
  visit("");
  return files;
}

type RequestAdapter = (path: string, init?: RequestInit) => Promise<Response>;
let live: TsProject;
let liveRequest: RequestAdapter;
let staticRequest: RequestAdapter;

beforeAll(async () => {
  const snapshot = exampleSnapshot();
  const staticRuntime = createStaticRuntime({
    snapshot,
    href: () => "https://demo.test/projects/archer-tour/?follow",
    storage: null,
  });
  staticRequest = (path, init) => staticRuntime.request(`https://demo.test/p/archer-tour/${path}`, init);
  live = await startTsProject({ files: tourFiles(), nestedView: true });
  const cookie = await signInCookie(live.url);
  liveRequest = (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    return liveRuntime.request(live.api(path), { ...init, headers });
  };
}, 30000);

afterAll(async () => live?.stop());

/** Request contract only: bridge ordering/recovery has its own production suites. */
describe.each(["live", "static"] as const)("%s runtime request contract", (kind) => {
  const request: RequestAdapter = (path, init) => (kind === "live" ? liveRequest : staticRequest)(path, init);

  it("reads production inventory and a schema-valid compiled envelope", async () => {
    const response = await request("api/diagrams");
    expect(response.status).toBe(200);
    const inventory = parseInventory(await response.json());
    expect(inventory).toHaveLength(8);
    expect(inventory?.find((view) => view.id === "containers")?.title).toBe("Archer Containers");
    const envelopeResponse = await request("api/diagrams/containers");
    expect(envelopeResponse.status).toBe(200);
    const envelope = await envelopeResponse.json();
    expect(validateEnvelope(envelope)).toMatchObject({ ok: true });
    expect(envelope.view.id).toBe("containers");
    expect(envelope.revision).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("answers missing resources as refusals rather than valid empty data", async () => {
    for (const path of ["api/not-a-real-route", "api/diagrams/no-such-diagram"]) {
      const response = await request(path);
      expect(response.ok, path).toBe(false);
      expect(response.status, path).toBe(404);
    }
  });

  it("returns independently consumable bodies and never shares mutable parsed answers", async () => {
    const first = await request("api/diagrams");
    const firstBody = await first.json();
    firstBody.views.length = 0;
    expect(first.bodyUsed).toBe(true);
    const second = await request("api/diagrams");
    expect(second === first).toBe(false);
    expect(second.bodyUsed).toBe(false);
    expect(parseInventory(await second.json())).toHaveLength(8);
  });

  it("rejects a request that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(request("api/diagrams", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels a response body that has not yet been consumed", async () => {
    const controller = new AbortController();
    const response = await request("api/diagrams", { signal: controller.signal });
    expect(response.bodyUsed).toBe(false);
    controller.abort();
    await expect(response.json()).rejects.toMatchObject({ name: "AbortError" });
  });
});
