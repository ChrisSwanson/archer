/** The public guide inventory: shared by source-link rewriting and machine-readable exports. */
export const guideDocuments = [
  {
    source: "docs/install.md",
    path: "install",
    title: "Install Archer",
    summary: "Install a GitHub Release with npx, a verified shell installer or a manual download.",
  },
  {
    source: "site/why.md",
    path: "why",
    title: "Why Archer?",
    summary: "Understand a codebase, review a proposal and keep the shared understanding.",
  },
  {
    source: "site/how-it-works.md",
    path: "how-it-works",
    title: "How Archer works",
    summary: "Local files, agent tools, the browser and a maintained architecture pack.",
  },
  {
    source: "site/usage.md",
    path: "usage",
    title: "Use Archer with your agent",
    summary: "Start a project, present diagrams, highlight answers and exchange feedback.",
  },
  {
    source: "docs/other-agents.md",
    path: "other-agents",
    title: "Use Archer with another agent",
    summary:
      "Register archer mcp, install the skill and poll for messages when your agent is not Claude Code or Codex.",
  },
  {
    source: "docs/tls.md",
    path: "security/network-access",
    title: "HTTPS & Browser Trust",
    summary: "Enable another device, trust the public certificate and fix common connection problems.",
  },
] as const;
