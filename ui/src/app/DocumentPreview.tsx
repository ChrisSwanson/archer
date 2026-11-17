import { browserFetch } from "./browser-resource";
import { useEffect, useRef, useState, type JSX } from "react";
import type { FileRow } from "./file-index";
import "./ProjectBrowser.css";
import { thumbnailVersion } from "./thumbnail-version";
import {
  documentPreviewKey,
  loadDocumentPreview,
  noteDescriptionPreview,
  serviceThumbnailUrl,
  type DocumentPreview as PreviewValue,
} from "./document-previews";

export type DocumentPreviewProps = {
  readonly row: FileRow;
  /** The current project's page URL; cross-project URLs are derived from it. */
  readonly baseUrl: string;
  readonly theme: "light" | "dark";
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** The card shows without scrolling: its thumbnail is asked for at once, ahead of the others. */
  readonly firstScreen?: boolean;
};

/**
 * A first-screen thumbnail is fetched at once at high priority (over HTTP/1.1's six connections the
 * browser sends those first); the rest load lazily at the browser's default image priority.
 */
export function DiagramThumbnail({
  src,
  title,
  onError,
  firstScreen = false,
}: {
  readonly src: string;
  readonly title: string;
  readonly onError?: () => void;
  readonly firstScreen?: boolean;
}): JSX.Element {
  return (
    <img
      className="archer-document-preview-image"
      src={src}
      alt={`Diagram thumbnail: ${title}`}
      loading={firstScreen ? "eager" : "lazy"}
      decoding="async"
      {...(firstScreen ? { fetchPriority: "high" as const } : {})}
      {...(onError === undefined ? {} : { onError })}
    />
  );
}

export function NoteExcerpt({
  text,
  source,
}: {
  readonly text: string;
  readonly source: "description" | "excerpt";
}): JSX.Element {
  return (
    <div className="archer-document-preview-note" data-source={source}>
      <p>{text}</p>
    </div>
  );
}

export function chooseDocumentPreview(value: PreviewValue, title: string): JSX.Element {
  switch (value.kind) {
    case "diagram":
      return <DiagramThumbnail src={value.src} title={title} />;
    case "note":
      return <NoteExcerpt text={value.text} source={value.source} />;
    case "unavailable":
      return (
        <p className="archer-document-preview-state" role="status">
          {value.message}
        </p>
      );
  }
}

type Held = { readonly key: string; readonly value: PreviewValue };

export function DocumentPreview({
  row,
  baseUrl,
  theme,
  fetchImpl,
  firstScreen = false,
}: DocumentPreviewProps): JSX.Element {
  const fetcher = fetchImpl ?? defaultFetch;
  const identity = documentPreviewKey(row, baseUrl, theme, fetcher);
  const rowRef = useRef(row);
  const targetRef = useRef<HTMLDivElement>(null);
  rowRef.current = row;
  const direct =
    row.kind === "note" && row.description !== undefined
      ? noteDescriptionPreview(row.description)
      : row.kind === "diagram" && row.failing
        ? { kind: "unavailable" as const, message: "This diagram does not compile; no thumbnail was requested." }
        : null;
  // The service draws and the browser caches a compiled diagram's thumbnail
  // (`<img loading=lazy>` waits for the screen by itself). Only when that
  // address is unavailable or fails (the drawing failed) does the page
  // paint the preview itself.
  const served = direct === null ? serviceThumbnailUrl(row, baseUrl, theme) : null;
  const [failedServed, setFailedServed] = useState<string | null>(null);
  const useServed = served !== null && failedServed !== served;
  // A service that announces a thumbnail version draws thumbnails itself; when its drawing fails,
  // painting the whole diagram in the page (a full export) would be slower and fail the same way.
  const servedRefused = served !== null && failedServed === served && thumbnailVersion() !== undefined;
  const needsRequest = direct === null && !useServed && !servedRefused;
  const [nearKey, setNearKey] = useState<string | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const visibleValue = direct ?? (held?.key === identity ? held.value : null);

  useEffect(() => {
    if (!needsRequest) {
      setNearKey(identity);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setNearKey(identity);
      return;
    }
    const target = targetRef.current;
    if (target === null) {
      setNearKey(identity);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearKey(identity);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [identity, needsRequest]);

  useEffect(() => {
    if (!needsRequest || nearKey !== identity) return;
    const request = new AbortController();
    let active = true;
    setHeld(null);
    void loadDocumentPreview(rowRef.current, baseUrl, theme, fetcher, request.signal)
      .then((value) => {
        if (active && !request.signal.aborted) setHeld({ key: identity, value });
      })
      .catch((error: unknown) => {
        if (!active || request.signal.aborted) return;
        setHeld({
          key: identity,
          value: { kind: "unavailable", message: error instanceof Error ? error.message : "Preview is unavailable." },
        });
      });
    return () => {
      active = false;
      request.abort();
    };
  }, [identity, nearKey, needsRequest, baseUrl, theme, fetcher]);

  const value = servedRefused
    ? { kind: "unavailable" as const, message: "No preview for this diagram." }
    : (visibleValue ??
      (nearKey === identity
        ? { kind: "unavailable" as const, message: "Loading preview…" }
        : { kind: "unavailable" as const, message: "Preview loads when it is near the screen." }));
  const content = useServed ? (
    <DiagramThumbnail
      src={served}
      title={row.title}
      firstScreen={firstScreen}
      onError={() => setFailedServed(served)}
    />
  ) : (
    chooseDocumentPreview(value, row.title)
  );
  return (
    <div
      className="archer-document-preview-content"
      ref={targetRef}
      data-kind={row.kind}
      role="group"
      aria-label={`${row.kind === "diagram" ? "Diagram" : "Note"} preview for ${row.title}`}
    >
      {content}
    </div>
  );
}

const defaultFetch = (url: string, init?: RequestInit): Promise<Response> => browserFetch(url, init);
