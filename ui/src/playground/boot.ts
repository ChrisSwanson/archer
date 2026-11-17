import { readBrowserRoute } from "../../../shared/browser-routes.mts";
import { HERO_PROJECT, type PlaygroundIndex } from "../../../shared/playground-delivery.mts";
import type { PlaygroundSnapshot } from "../../../shared/playground-snapshot.mts";
import { selectPageRuntime } from "../app/runtime.ts";
import { selectAddressCodec } from "../runtime/address.ts";
import { browserStateKey, configureStaticAddress, decodeAddress, encodeAddress } from "./address";
import { loadPlaygroundSnapshot, projectLoader, readPlaygroundIndex } from "./load";
import { createStaticRuntime, type StaticRuntime } from "./runtime.ts";

export interface PlaygroundBoot {
  readonly index: PlaygroundIndex;
  readonly snapshot: PlaygroundSnapshot;
  readonly runtime: StaticRuntime;
  readonly hero: boolean;
}

/** Selects the static address codec, canonicalizes the address, then loads only the routed project. */
export async function bootPlayground(fetcher: typeof fetch = fetch): Promise<PlaygroundBoot> {
  const index = readPlaygroundIndex(document);
  configureStaticAddress({ documentUrl: window.location.href, digest: index.manifest.digest });
  // Before anything reads browser state (theme, drafts, this tab's id) or an address.
  selectAddressCodec({ encodeAddress, decodeAddress, browserStateKey });
  const address = new URL(window.location.href);
  const hero = address.searchParams.get("scene") === "hero";
  if (hero) {
    const logical = new URL(decodeAddress(window.location.href));
    // The scene opens the Tour diagram its address names (the landing's poster), or the containers.
    const diagram = new RegExp(`^/projects/${HERO_PROJECT}/diagrams/[a-z0-9-]+\\.mmd$`, "u");
    if (!diagram.test(logical.pathname)) logical.pathname = `/projects/${HERO_PROJECT}/diagrams/containers.mmd`;
    window.history.replaceState(null, "", encodeAddress(logical.href));
  } else if (!address.searchParams.has("route")) {
    window.history.replaceState(
      null,
      "",
      encodeAddress(`/projects/${index.projects[0]!.slug}/diagrams/containers.mmd`),
    );
  } else if (window.location.pathname.endsWith("/")) {
    const logical = decodeAddress(window.location.href);
    // Invalid route queries stay invalid; never turn them into a plausible project.
    if (!new URL(logical).pathname.startsWith("/__invalid-playground-route__"))
      window.history.replaceState(null, "", encodeAddress(logical));
  }
  const logical = new URL(decodeAddress(window.location.href));
  const route = readBrowserRoute(logical.pathname, logical.search, logical.hash);
  const routed = route && route.kind !== "projects" ? route.projectSlug : index.projects[0]!.slug;
  const slug = hero ? HERO_PROJECT : index.projects.some((entry) => entry.slug === routed) ? routed : undefined;
  const load = projectLoader(index, window.location.href, fetcher);
  const snapshot = await loadPlaygroundSnapshot(index, slug ? [slug] : [], window.location.href, fetcher, load);
  const runtime = createStaticRuntime({
    snapshot,
    href: () => decodeAddress(window.location.href),
    // The compact scene shows only its own project; the Playground opens the others when a person goes to them.
    ...(hero ? { storage: null } : { load }),
  });
  selectPageRuntime(runtime);
  return { index, snapshot, runtime, hero };
}
