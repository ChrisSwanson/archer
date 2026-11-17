// A package ships every installation asset the service loads at run time.
import { expect, test } from "vitest";
import { DEVELOPMENT_ASSETS } from "../../src/assets.ts";
import { packageManifest } from "../../scripts/package.ts";
import { SHIPPED } from "../../scripts/bundle.ts";

test("every installation asset is in the bundle's shipped list", () => {
  const shipped = new Set(SHIPPED.map(([, to]) => to));
  const missing = Object.keys(DEVELOPMENT_ASSETS).filter((name) => !shipped.has(`assets/${name}`));
  expect(missing).toEqual([]);
});

test("the package allows root examples and excludes the test corpus", () => {
  const manifest = packageManifest("1.0.0");
  expect(manifest.files).toContain("examples/");
  expect(manifest.files).not.toContain("test/");
});
