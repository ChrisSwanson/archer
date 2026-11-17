/**
 * An isolated project holding the nested C4 fixture (Web shop > API > Checkout, Catalog) and a
 * sidecar of two walkthroughs over it: one that records Web shop as open, one that records nothing.
 * For the follow camera and the nested rules (slice 5). Never the live service.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const nestedSource = (): string =>
  readFileSync(resolve(import.meta.dirname, "../../../ts/test/fixtures/c4/nested.mmd"), "utf8");

// A stored step names its own id (ADR 0034; required since 0.15.0).
const step = (title: string, edge: { id: string; source: string; target: string; label: string }) => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  title,
  kind: "sends",
  what: `${title}.`,
  code: [],
  edges: [edge],
  messages: [{ from: edge.source, to: edge.target, label: edge.label }],
});
const steps = [
  step("Shop", { id: "customer--web", source: "customer", target: "web", label: "Shops with" }),
  step("Place the order", { id: "web--checkout", source: "web", target: "checkout", label: "Places orders" }),
  step("Save the order", { id: "checkout--orders", source: "checkout", target: "orders", label: "Writes orders" }),
  step("Charge the card", { id: "checkout--payments", source: "checkout", target: "payments", label: "Charges cards" }),
];
const walk = (id: string, title: string, open: string[]) => ({
  id,
  title,
  revision: 1,
  modelRevision: `sha256:${"0".repeat(64)}`,
  author: "agent",
  writtenAt: "2026-10-23T10:00:00Z",
  open,
  steps,
});

export function nestedWalkthroughFiles(): Record<string, string> {
  return {
    "archer.toml": 'version = 1\n[[views]]\nid = "shop"\nkind = "c4"\ntitle = "Shop"\nsource = ".archer/shop.mmd"\n',
    ".archer/shop.mmd": nestedSource(),
    ".archer/shop.walkthroughs.json": JSON.stringify({
      schemaVersion: 1,
      target: "view:shop",
      walkthroughs: [walk("order", "Order a book", ["shop"]), walk("bare", "Order, nothing recorded", [])],
    }),
  };
}
