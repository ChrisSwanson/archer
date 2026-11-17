// The delivery order and automatic launch (ADR 0035, amended 2026-10-31). The person sets them in their own
// archer.toml `[agents]` and per project in its `[[projects]]` rules; a project's own archer.toml has an
// `[agents]` table that may only narrow them (drop steps, launch "ask"/"off", launch_for "owner"), so a cloned
// repository can never make Archer start a process. Read fresh at each decision (service.ts).
import type { TomlTable, TomlValue } from "../project/toml.ts";

/** A delivery step, in the one order they may appear: an agent listening now, a session's next turn, the launcher. */
export type DeliveryStep = "listener" | "next_turn" | "launch";
/** `auto`: launch when no step before took the message; `ask`: the owner's Launch button (today); `off`: neither. */
export type LaunchMode = "auto" | "ask" | "off";
/** Whose messages may start an automatic launch: the owner's own sign-in from this computer, or anyone's. */
export type LaunchFor = "owner" | "anyone";

export const DELIVERY_STEPS: readonly DeliveryStep[] = ["listener", "next_turn", "launch"];
const LAUNCH_MODES: readonly LaunchMode[] = ["auto", "ask", "off"];
const LAUNCH_FOR: readonly LaunchFor[] = ["owner", "anyone"];
/** The longest next_turn_wait: a listener silent this long has long been away (LISTENER_FORGET_MS). */
export const MAX_NEXT_TURN_WAIT_MS = 30 * 60_000;

/** The four settings as written in the person's file (`[agents]`, or one `[[projects]]` rule). */
export interface DeliverySettings {
  readonly delivery?: readonly DeliveryStep[];
  readonly nextTurnWaitMs?: number;
  readonly launch?: LaunchMode;
  readonly launchFor?: LaunchFor;
}

/** What a project's own archer.toml may say: only narrowing values. */
export interface ProjectAgentsSettings {
  readonly delivery?: readonly DeliveryStep[];
  readonly launch?: "ask" | "off";
  readonly launchFor?: "owner";
}

/** What one project's messages get, every setting resolved. `launch` is `off` whenever `launch` is not in `order`. */
export interface DeliveryPolicy {
  readonly order: readonly DeliveryStep[];
  readonly nextTurnWaitMs: number;
  readonly launch: LaunchMode;
  readonly launchFor: LaunchFor;
}

/**
 * Nobody configured anything (no launcher): Launch is the button's alone, and with no launcher nothing launches.
 * Once the person sets a launcher, `launch` defaults to "auto" (decision D9, 2026-10-31).
 */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = Object.freeze({
  order: DELIVERY_STEPS,
  nextTurnWaitMs: 120_000,
  launch: "ask",
  launchFor: "owner",
});

type Fail = (why: string) => Error;
const ACCOUNT_FILE = "~/.config/archer/archer.toml";

/** The order, checked: `listener` first, the steps in DELIVERY_STEPS's order, each once. */
function parseOrder(value: TomlValue, where: string, fail: Fail): DeliveryStep[] {
  const usage = `${where} \`delivery\` must list steps from "listener", "next_turn", "launch", in that order, starting with "listener" (a listening agent always gets the message first), such as ["listener", "next_turn", "launch"]`;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((step) => typeof step === "string" && DELIVERY_STEPS.includes(step as DeliveryStep))
  )
    throw fail(usage);
  const steps = value as DeliveryStep[];
  if (steps[0] !== "listener") throw fail(usage);
  const positions = steps.map((step) => DELIVERY_STEPS.indexOf(step));
  if (positions.some((at, i) => i > 0 && at <= positions[i - 1]!))
    throw fail(`${usage}; each step once, in that order`);
  return steps;
}

/** `"90s"`, `"2m"`: whole seconds or minutes, 0 through MAX_NEXT_TURN_WAIT_MS. */
function parseWait(value: TomlValue, where: string, fail: Fail): number {
  const match = typeof value === "string" ? /^(\d{1,5})(s|m)$/u.exec(value) : null;
  const ms = match === null ? NaN : Number(match[1]) * (match[2] === "m" ? 60_000 : 1_000);
  if (!(ms >= 0 && ms <= MAX_NEXT_TURN_WAIT_MS))
    throw fail(
      `${where} \`next_turn_wait\` must be a quoted time of whole seconds or minutes from "0s" through "30m", such as "2m" or "90s"`,
    );
  return ms;
}

function oneOf<T extends string>(value: TomlValue, allowed: readonly T[], what: string, fail: Fail): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw fail(
      `${what} must be ${allowed
        .map((v) => JSON.stringify(v))
        .join(", ")
        .replace(/, ([^,]*)$/u, " or $1")}`,
    );
  return value as T;
}

/** The four delivery keys of `[agents]` or a `[[projects]]` rule in the person's own file; other keys are the caller's. */
export function parseDeliverySettings(doc: TomlTable, where: string, fail: Fail): DeliverySettings {
  const delivery = doc["delivery"] === undefined ? undefined : parseOrder(doc["delivery"], where, fail);
  const nextTurnWaitMs =
    doc["next_turn_wait"] === undefined ? undefined : parseWait(doc["next_turn_wait"], where, fail);
  const launch =
    doc["launch"] === undefined ? undefined : oneOf(doc["launch"], LAUNCH_MODES, `${where} \`launch\``, fail);
  const launchFor =
    doc["launch_for"] === undefined ? undefined : oneOf(doc["launch_for"], LAUNCH_FOR, `${where} \`launch_for\``, fail);
  return {
    ...(delivery === undefined ? {} : { delivery }),
    ...(nextTurnWaitMs === undefined ? {} : { nextTurnWaitMs }),
    ...(launch === undefined ? {} : { launch }),
    ...(launchFor === undefined ? {} : { launchFor }),
  };
}

export const DELIVERY_KEYS: readonly string[] = ["delivery", "next_turn_wait", "launch", "launch_for"];

/** The headers besides [agents] (and the account's [[projects]]) where a delivery key's name is another setting's: [feedback] has its own `delivery`. */
export const deliveryKeyAlsoUnder = (key: string): readonly string[] => (key === "delivery" ? ["[feedback]"] : []);

/** A project's own `[agents]`: only what narrows the person's settings; anything else is refused by name. */
export function parseProjectAgents(value: TomlValue, fail: Fail): ProjectAgentsSettings {
  if (typeof value !== "object" || Array.isArray(value)) throw fail("`agents` must be one [agents] table");
  for (const key of Object.keys(value)) {
    if (key === "launcher" || key === "next_turn_wait")
      throw fail(
        `[agents] \`${key}\` can be set only in your own ${ACCOUNT_FILE}; a project's archer.toml may only narrow delivery (launch = "off" or "ask", launch_for = "owner", or steps left out of delivery)`,
      );
    if (!DELIVERY_KEYS.includes(key))
      throw fail(
        `unknown [agents] setting ${JSON.stringify(key)}; a project's archer.toml takes delivery, launch ("ask" or "off") and launch_for ("owner")`,
      );
  }
  const settings = parseDeliverySettings(value, "[agents]", fail);
  // Fewer steps must mean fewer launches (C-33): without next_turn a message would launch without the wait.
  if (settings.delivery?.includes("launch") && !settings.delivery.includes("next_turn"))
    throw fail(
      `[agents] \`delivery\` may leave out "next_turn" only together with "launch": without the wait for a session's next turn an agent would be launched sooner, and a project's archer.toml may only narrow delivery; write ["listener", "next_turn", "launch"], ["listener", "next_turn"] or ["listener"]`,
    );
  if (settings.launch === "auto")
    throw fail(
      `[agents] launch = "auto" can be set only in your own ${ACCOUNT_FILE}; a project's archer.toml may say "ask" or "off"`,
    );
  if (settings.launchFor === "anyone")
    throw fail(
      `[agents] launch_for = "anyone" can be set only in your own ${ACCOUNT_FILE}; a project's archer.toml may say "owner"`,
    );
  return {
    ...(settings.delivery === undefined ? {} : { delivery: settings.delivery }),
    ...(settings.launch === undefined ? {} : { launch: settings.launch as "ask" | "off" }),
    ...(settings.launchFor === undefined ? {} : { launchFor: "owner" as const }),
  };
}

/** The narrower of two launch modes (off < ask < auto) and of two launch_for values (owner < anyone). */
const narrowerLaunch = (a: LaunchMode, b: LaunchMode | undefined): LaunchMode =>
  b === undefined || LAUNCH_MODES.indexOf(a) >= LAUNCH_MODES.indexOf(b) ? a : b;
const narrowerFor = (a: LaunchFor, b: LaunchFor | undefined): LaunchFor => (b === "owner" ? "owner" : a);

/**
 * One project's policy: the person's `[agents]`, then their `[[projects]]` rule for this root (matched by path,
 * as `launcher_cwd` is), then the project's own `[agents]`, which only narrows: its order keeps the person's steps
 * it names and adds none, and its launch and launch_for count only when narrower.
 */
export function deliveryPolicy(
  user: {
    readonly version?: 1;
    readonly agents?: DeliverySettings & { readonly launcher?: readonly string[] };
    readonly projects?: readonly ({ readonly path: string } & DeliverySettings)[];
  },
  project: { readonly agents?: ProjectAgentsSettings } | undefined,
  root: string,
  realRoot: string = root,
): DeliveryPolicy {
  const rule = user.projects?.find((entry) => entry.path === root || entry.path === realRoot);
  const base = user.agents ?? {};
  let order = rule?.delivery ?? base.delivery ?? DEFAULT_DELIVERY_POLICY.order;
  const launcherSet = (user.agents?.launcher?.length ?? 0) > 0;
  let launch = rule?.launch ?? base.launch ?? (launcherSet ? "auto" : DEFAULT_DELIVERY_POLICY.launch);
  let launchFor = rule?.launchFor ?? base.launchFor ?? DEFAULT_DELIVERY_POLICY.launchFor;
  const nextTurnWaitMs = rule?.nextTurnWaitMs ?? base.nextTurnWaitMs ?? DEFAULT_DELIVERY_POLICY.nextTurnWaitMs;
  const own = project?.agents;
  if (own?.delivery !== undefined) order = order.filter((step) => own.delivery!.includes(step));
  launch = narrowerLaunch(launch, own?.launch);
  launchFor = narrowerFor(launchFor, own?.launchFor);
  if (!order.includes("launch")) launch = "off";
  return { order, nextTurnWaitMs, launch, launchFor };
}
