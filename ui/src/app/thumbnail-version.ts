/**
 * The service's thumbnail version (`thumbnailVersion` on the inventory and the
 * project catalog): the painter that draws previews. It is part of each
 * preview's address (`&v=`), so after an upgrade the browser asks for new
 * drawings instead of answering from last version's immutable cache. Every
 * project on a page is served by one service, so one value holds for all.
 * The inventory's live updates do not carry it; the last value read stays.
 */
let current: string | undefined;
/**
 * The format the service wants previews asked for (`thumbnailFormat`, beside the version on the same
 * listings): `svg` unless it names `png`. Like the version, one value per service; updates without it keep it.
 */
let format: ThumbnailFormat = "svg";
export type ThumbnailFormat = "svg" | "png";

/** Keep `value` when it is a version token; anything else leaves the known one. */
export function rememberThumbnailVersion(value: unknown): void {
  if (typeof value === "string" && /^[0-9a-f]{1,64}$/.test(value)) current = value;
}

export function thumbnailVersion(): string | undefined {
  return current;
}

/** Keep `value` when it names a format this page can show; anything else (or nothing) leaves the known one. */
export function rememberThumbnailFormat(value: unknown): void {
  if (value === "svg" || value === "png") format = value;
}

export function thumbnailFormat(): ThumbnailFormat {
  return format;
}

/** For tests. */
export function forgetThumbnailVersion(): void {
  current = undefined;
  format = "svg";
}
