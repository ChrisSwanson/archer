import type { ProjectedView } from "../src/diagrams/projection";

type N = [id: string, label: string, shape: string, cls: string | undefined, group?: string];
type E = [id: string, source: string, target: string, label: string];

function build(
  viewId: string,
  nodes: readonly N[],
  edges: readonly E[],
  groups: readonly [string, string, string | undefined][] = [],
): ProjectedView {
  return {
    viewId,
    kind: "freeform",
    title: viewId,
    revision: "1",
    modelType: "freeform-graph",
    nodes: nodes.map(([id, label, shape, cls, groupId]) => ({
      id,
      label,
      shape,
      classes: cls === undefined ? [] : [cls],
      groupId,
    })),
    edges: edges.map(([id, source, target, label]) => ({ id, source, target, label })),
    groups: groups.map(([id, label, parentId]) => ({ id, label, parentId })),
  };
}

/**
 * The system context the caption collision was first seen on: two antiparallel
 * wires between the same pair of nodes, each with a long caption, and node
 * labels long enough to need two and three lines.
 */
export function systemContextView(): ProjectedView {
  return build(
    "system-context",
    [
      ["agent", "Coding agent", "rectangle", "person"],
      ["dev", "Developer", "rectangle", "person"],
      ["archer", "Archer (architecture diagram MCP server)", "rectangle", "system"],
      ["host", "MCP client (Claude Code, IDE, desktop app)", "rectangle", "external"],
      ["repo", "Workspace repository (archer.toml and .mmd sources)", "rectangle", "external"],
      ["browser", "Web browser", "rectangle", "external"],
    ],
    [
      ["asks", "dev", "agent", "asks for a diagram"],
      ["writes", "agent", "host", "authors Mermaid, calls Archer tools"],
      ["launches", "host", "archer", "runs Archer in the repo directory"],
      ["compiles", "archer", "repo", "reads and writes diagram sources"],
      ["renders", "archer", "browser", "serves the interactive canvas"],
      ["looks", "dev", "browser", "reads the rendered diagram"],
      ["reports", "archer", "host", "compiled model, diagnostics, selection"],
    ],
  );
}

/** Nested groups, with every shape family and most semantic classes in play. */
export function containersView(): ProjectedView {
  return build(
    "containers",
    [
      ["user", "Customer", "rectangle", "person"],
      ["admin", "Support agent", "rectangle", "person"],
      ["cdn", "CDN", "rectangle", "external", "edge"],
      ["gw", "API gateway", "rectangle", "container", "edge"],
      ["web", "Web application (Next.js)", "rectangle", "container", "app"],
      ["orders", "Order service", "rectangle", "container", "app"],
      ["billing", "Billing service", "rectangle", "container", "app"],
      ["notify", "Notification worker", "rectangle", "component", "app"],
      ["pg", "Orders database (Postgres)", "rectangle", "database", "data"],
      ["cache", "Session cache (Redis)", "rectangle", "database", "data"],
      ["q", "Event queue", "stadium", undefined, "data"],
      ["stripe", "Stripe", "rectangle", "external"],
      ["mail", "Email provider", "rectangle", "external"],
      ["decide", "Fraud check?", "diamond", undefined],
    ],
    [
      ["e1", "user", "cdn", "browses"],
      ["e2", "cdn", "gw", "forwards dynamic requests"],
      ["e3", "gw", "web", "routes"],
      ["e4", "web", "orders", "places order"],
      ["e5", "orders", "pg", "reads and writes"],
      ["e6", "orders", "q", "publishes OrderPlaced"],
      ["e7", "q", "billing", "delivers"],
      ["e8", "billing", "stripe", "charges card"],
      ["e9", "q", "notify", "delivers"],
      ["e10", "notify", "mail", "sends receipt"],
      ["e11", "web", "cache", "session lookup"],
      ["e12", "admin", "billing", "refunds"],
      ["e13", "billing", "decide", "scores"],
      ["e14", "decide", "admin", "flagged"],
    ],
    [
      ["edge", "Edge", undefined],
      ["app", "Application services", undefined],
      ["data", "Data stores", "app"],
    ],
  );
}
