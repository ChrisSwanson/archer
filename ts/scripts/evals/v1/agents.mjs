// The small agents the evals measure (docs/evaluations/eval-baseline.md).
export const AGENTS = {
  haiku: { kind: "claude", model: "claude-haiku-5-5", effort: "medium" },
  sol: { kind: "codex", model: "gpt-6.1-sol", effort: "medium" },
  luna: { kind: "codex", model: "gpt-5.6-luna", effort: "medium" },
  // The one model of the cut-down v1 normalisation evals (decided 2026-11-04); only when named (--agents sonnet).
  sonnet: { kind: "claude", model: "claude-sonnet-5-5", effort: "medium", optIn: true },
};

/** The agents a campaign runs when --agents is not given. */
export const DEFAULT_AGENTS = Object.keys(AGENTS).filter((name) => !AGENTS[name].optIn);
