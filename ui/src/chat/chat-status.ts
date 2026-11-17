/**
 * The chat bubble's one status line (D7): what happened to the person's last message. The bubble shows it in
 * one slot, announced as a status and never focused; nothing else in the bubble speaks about delivery.
 *
 * How the agent gets a message is `AgentDelivery`, the line's only outside input. Without the service's
 * `listeners` capability the agent pulls (0.6.4): a sent message is stored and the agent sees it the next time it
 * reads comments, so the line says exactly that. With it (ADR 0035 §8) the line says what the listing says:
 * "Listening · Claude Code" only while a listener's `archer wait` is connected, "Waiting for the agent's next turn"
 * while one holds the claim, "The agent is away" once it has been silent for two minutes, "No agent is listening in
 * this checkout" with what to do, "checking" while the listing is being read again (the stream dropped, or a
 * read failed and is retried), and "can't tell" once the reads gave up: never an old "Listening", and never
 * "checking" for ever (decision 25). It never claims more.
 */
import type { AgentHost, PendingDelivery } from "../../../ts/src/agents/contract";
import type { Thread } from "../comments/contract";
import { STATUS_LABEL } from "../comments/state";

/** How the agent gets what the bubble sends. */
export type AgentDelivery =
  | { readonly kind: "pull" }
  | { readonly kind: "listening"; readonly host: AgentHost }
  | { readonly kind: "next-turn" }
  | { readonly kind: "away" }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" }
  | { readonly kind: "unreachable" };

/** Without the capability, or before the listing is known: the agent reads comments when it checks. */
export const AGENT_DELIVERY: AgentDelivery = { kind: "pull" };

export const HOST_NAME: Record<AgentHost, string> = { "claude-code": "Claude Code", codex: "Codex", other: "an agent" };

/** What a sent message waits for, given how the agent gets it. */
export function deliveryLine(delivery: AgentDelivery): string {
  switch (delivery.kind) {
    case "pull":
      return "Saved · the agent sees this the next time it checks";
    case "listening":
      return `Listening · ${HOST_NAME[delivery.host]}`;
    case "next-turn":
      return "Waiting for the agent's next turn";
    case "away":
      return "The agent is away · it sees this when it is back";
    case "none":
      return "No agent is listening in this checkout";
    case "unknown":
      return "Sent · checking whether an agent is listening";
    case "unreachable":
      return "Sent · can't tell whether an agent is listening";
  }
}

/** "2 min", "45 s", "1 min 30 s". */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000),
    minutes = Math.floor(seconds / 60),
    rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/**
 * The step a sent message is on in the delivery order (ADR 0035, amended 2026-10-31): a session's next turn, then
 * the person's launcher; or the launcher started. The service sends a step only when a launch follows.
 */
export function pendingLine(pending: PendingDelivery): string {
  if (pending.step === "launching") return "Starting an agent for this message…";
  const who = pending.host === "other" ? "the agent" : HOST_NAME[pending.host];
  return `Waiting ${duration(pending.waitMs)} for ${who}'s next turn, then launching an agent`;
}

/** Said with "No agent is listening": what the person can do about it. */
export const NONE_HINT = "Start an agent session in this project; it gets this message first.";

/** `hint`: a second sentence (what to do); `launch`: the person may press Launch for this message. */
export type ChatStatus = {
  readonly text: string;
  readonly retry: boolean;
  readonly hint?: string;
  readonly launch?: boolean;
};

/** The line under the person's last message: Sending, Not sent or May not have been sent (Retry), the wait for the agent, Read by the agent; the reply is its own bubble. */
export function chatStatus(
  thread: Thread | undefined,
  failed: boolean | "unsure",
  sending: boolean,
  delivery: AgentDelivery = AGENT_DELIVERY,
  canLaunch = false,
  pending?: PendingDelivery,
): ChatStatus | null {
  const say = (text: string, retry = false): ChatStatus => ({ text, retry });
  if (sending) return say("Sending…");
  const last = thread?.comments[thread.comments.length - 1];
  if (thread === undefined || last === undefined || last.author !== "person") return null;
  if (failed === "unsure") return say("May not have been sent", true);
  if (failed) return say("Not sent", true);
  switch (thread.status) {
    case "draft":
      return say("Draft, not sent");
    case "sent":
      // The delivery order's step says more than the listener's state; while an agent starts there is no Launch.
      if (pending !== undefined && pending.threadId === thread.id) return say(pendingLine(pending));
      if (delivery.kind === "none")
        return { text: deliveryLine(delivery), retry: false, hint: NONE_HINT, ...(canLaunch ? { launch: true } : {}) };
      return delivery.kind === "away" && canLaunch
        ? { text: deliveryLine(delivery), retry: false, launch: true }
        : say(deliveryLine(delivery));
    case "read":
      return say(STATUS_LABEL.read);
    default:
      return null;
  }
}
