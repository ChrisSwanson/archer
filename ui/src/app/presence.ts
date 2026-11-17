/**
 * The presence line: who put this diagram in front of the reader, or who last
 * changed it, and when (phase3-front-door.md).
 *
 *   "Presented by the agent · 2 min ago — <caption>"   the agent's presentation
 *   "Changed by the agent · 10:42 — <summary>"          a diagram the reader opened
 *   "Saved · 10:42"                                     the person's own save in this browser (the word a
 *                                                       person looks for after Save: flows-r1 claude-04)
 *   "Changed on disk · 10:42"                           any other write the agent did not announce: another
 *                                                       editor, Git, a script, another person (claude-206)
 *
 * Only what is known is said. "2 min ago" is the service's `presentedAt`; a
 * service without it leaves the time this page saw the agent present, and a
 * page that opened onto a presentation already made, with no `presentedAt`,
 * says no time at all rather than "just now".
 */
import type { DiagramView } from "./inventory";
import { savedByYou, type OwnSave } from "./own-saves";

export type PresenceTime = { readonly iso: string; readonly text: string };
/**
 * The longest caption the presence line carries. The agent's caption was
 * shown twice, in this line and in the "From the agent" bar under the
 * drawing; one is enough. A caption up to this long is said here, once, and
 * the bar is kept only for the screen reader. A longer one is a paragraph,
 * which a header line cannot hold: it stays in the bar, and this line says
 * only who and when.
 */
export const CAPTION_IN_HEADER_MAX_CHARS = 140;

export type Presence = {
  readonly lead: string;
  /** Whose doing it is: the agent's amber, the person's own save, or a write from outside Archer (neutral). */
  readonly voice: "agent" | "you" | "other";
  readonly time?: PresenceTime;
  readonly detail?: string;
  /** The detail is the agent's caption, which the bar under the drawing also holds for a screen reader. */
  readonly detailIsCaption?: boolean;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "just now", "3 min ago", "2 h ago": for times within the day. */
export function timeAgo(at: number, now: number): string {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  return `${Math.floor(ago / HOUR)} h ago`;
}

/**
 * A clock time, "10:42", with the date ahead of it when it is not today
 * ("2 Oct, 09:05"). `timeZone` is for tests; the page uses the reader's own.
 */
export function clockTime(iso: string, now: number, timeZone?: string): string {
  const at = new Date(iso);
  const zone = timeZone === undefined ? {} : { timeZone };
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...zone }).format(
    at,
  );
  const day = (date: Date): string =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", ...zone }).format(date);
  if (day(at) === day(new Date(now))) return time;
  const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...zone }).format(at);
  return `${date}, ${time}`;
}

export function presenceLine(input: {
  /** Who put the diagram on screen: the agent presenting it, or the reader opening it. */
  readonly origin: "agent" | "reader";
  readonly view?: DiagramView;
  /** When this page saw the agent present it, if it did. */
  readonly presentedAt?: number;
  /** The agent's caption for the presentation on screen. */
  readonly caption?: string | null;
  /** This browser's record of the person's last save of this view (own-saves.ts). */
  readonly ownSave?: OwnSave | null;
  /** The editor is open over the view: its own status speaks for the work in it, and the header never says Saved. */
  readonly editing?: boolean;
  readonly now: number;
  readonly timeZone?: string;
}): Presence | null {
  if (input.origin === "agent") {
    const presence: { lead: string; voice: "agent"; time?: PresenceTime; detail?: string; detailIsCaption?: boolean } =
      {
        lead: "Presented by the agent",
        voice: "agent",
      };
    // The service's time first (`presentedAt` on the inventory entry), then
    // the moment this page saw it happen.
    const served = input.view?.presentedAt === undefined ? undefined : Date.parse(input.view.presentedAt);
    const at = served ?? input.presentedAt;
    if (at !== undefined) {
      presence.time = { iso: new Date(at).toISOString(), text: timeAgo(at, input.now) };
    }
    const caption = input.caption ?? "";
    if (caption !== "" && [...caption].length <= CAPTION_IN_HEADER_MAX_CHARS) {
      presence.detail = caption;
      presence.detailIsCaption = true;
    }
    return presence;
  }
  const change = input.view?.lastChange;
  if (change === undefined) return null;
  const mine = change.by === "person" && savedByYou(input.ownSave, input.view);
  if (mine && input.editing === true) return null;
  const presence: { lead: string; voice: "agent" | "you" | "other"; time: PresenceTime; detail?: string } = {
    lead: change.by === "agent" ? "Changed by the agent" : mine ? "Saved" : "Changed on disk",
    voice: change.by === "agent" ? "agent" : mine ? "you" : "other",
    time: { iso: new Date(change.at).toISOString(), text: clockTime(change.at, input.now, input.timeZone) },
  };
  if (change.summary !== undefined) presence.detail = change.summary;
  return presence;
}
