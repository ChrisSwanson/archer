/**
 * What the service says of a file beside its name: when it was created and
 * last edited, and what it is about (the projects-and-search design).
 * Carried by inventory entries and note listings
 * alike; every field optional, each read on its own, so a malformed one costs
 * that field and not the file.
 */
export type CreatedSource = "filesystem" | "git";
export type DescriptionSource = "frontmatter" | "comment" | "derived";

export type FileFacts = {
  readonly createdAt?: string;
  readonly createdFrom?: CreatedSource;
  readonly modifiedAt?: string;
  readonly description?: string;
  readonly descriptionFrom?: DescriptionSource;
  /** Who wrote a note (its `author:` front matter): the agent or a person. */
  readonly author?: "agent" | "person";
};

/** A description longer than this is not one the service sends; it is cut rather than trusted. */
const MAX_DESCRIPTION_CHARS = 500;

const isDate = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));

/** The facts `record` carries; whatever is malformed is left out. */
export function parseFileFacts(record: Readonly<Record<string, unknown>>): FileFacts {
  const facts: { -readonly [K in keyof FileFacts]: FileFacts[K] } = {};
  if (isDate(record.createdAt) && (record.createdFrom === "filesystem" || record.createdFrom === "git")) {
    facts.createdAt = record.createdAt;
    facts.createdFrom = record.createdFrom;
  }
  if (isDate(record.modifiedAt)) facts.modifiedAt = record.modifiedAt;
  if (typeof record.description === "string" && record.description.trim() !== "") {
    facts.description = [...record.description.trim()].slice(0, MAX_DESCRIPTION_CHARS).join("");
    if (
      record.descriptionFrom === "frontmatter" ||
      record.descriptionFrom === "comment" ||
      record.descriptionFrom === "derived"
    )
      facts.descriptionFrom = record.descriptionFrom;
  }
  if (record.author === "agent" || record.author === "person") facts.author = record.author;
  return facts;
}

const DAY_MS = 86_400_000;

/**
 * One formatter per option set, made on first use. `toLocale*String` with
 * options builds a new `Intl.DateTimeFormat` on every call, which cost ~190 ms
 * per table render (perf #8); these give the same text.
 */
function formatter(options: Intl.DateTimeFormatOptions): () => Intl.DateTimeFormat {
  let made: Intl.DateTimeFormat | undefined;
  return () => (made ??= new Intl.DateTimeFormat(undefined, options));
}
const timeOfDay = formatter({ hour: "2-digit", minute: "2-digit" });
const dayMonth = formatter({ day: "numeric", month: "short" });
const dayMonthYear = formatter({ day: "numeric", month: "short", year: "numeric" });
const dateAndTime = formatter({ dateStyle: "long", timeStyle: "short" });
/** `format` refuses an invalid date, where `toLocale*String` answered "Invalid Date"; so does this. */
const shown = (format: () => Intl.DateTimeFormat, date: Date): string =>
  Number.isNaN(date.getTime()) ? "Invalid Date" : format().format(date);

/**
 * A date as a column shows it: the time of day today, the day and month this
 * year, and the year as well before that. Tabular, short, and the same for
 * every row on a page (`now` is the page's clock).
 */
export function shortDate(iso: string, now: number): string {
  const date = new Date(iso);
  const today = new Date(now);
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  )
    return shown(timeOfDay, date);
  const thisYear = date.getFullYear() === today.getFullYear() && Math.abs(now - date.getTime()) < 300 * DAY_MS;
  return shown(thisYear ? dayMonth : dayMonthYear, date);
}

/** The full date and time, for a tooltip and a screen reader. */
export function longDate(iso: string): string {
  return shown(dateAndTime, new Date(iso));
}

/** Where a created date came from, said plainly (the tooltip on every Created cell). */
export function createdSourcePhrase(source: CreatedSource): string {
  return source === "filesystem"
    ? "from the file system's creation time"
    : "from Git: the commit that first added the file";
}

/** Where a description came from, said plainly. */
export function descriptionSourcePhrase(source: DescriptionSource | undefined): string {
  switch (source) {
    case "frontmatter":
      return "From the note's description front matter";
    case "comment":
      return "From the diagram's %% description: line";
    default:
      return "The first lines of the file; add a description to replace them";
  }
}
