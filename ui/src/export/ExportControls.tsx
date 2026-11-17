import { useEffect, useRef, useState, type JSX } from "react";
import type { AccuracyOperationCaller } from "../accuracy/RevisionCompare";
import { PageOperationError } from "../accuracy/client";
import { readArtifact, saveArtifact } from "./download";
import "./export-controls.css";
import { useGroupNumbers } from "../emphasis/group-numbers";
export interface ExportControlsProps {
  readonly viewId: string;
  readonly revision: string;
  readonly annotation: string;
  readonly activeEmphasisId: string | null;
  readonly theme: "light" | "dark";
  readonly callOperation: AccuracyOperationCaller;
  readonly onClose: () => void;
}
export function ExportControls(props: ExportControlsProps): JSX.Element {
  return <ExportSession key={`${props.viewId}:${props.revision}`} {...props} />;
}
function ExportSession({
  viewId,
  revision,
  annotation,
  activeEmphasisId,
  theme: initialTheme,
  callOperation,
  onClose,
}: ExportControlsProps): JSX.Element {
  const first = useRef<HTMLSelectElement>(null);
  const alive = useRef(true);
  const request = useRef(0);
  const [format, setFormat] = useState<"svg" | "png">("svg");
  const [mode, setMode] = useState<"diagram" | "presentation">("diagram");
  const [theme, setTheme] = useState(initialTheme);
  const [caption, setCaption] = useState(true);
  const [key, setKey] = useState(true);
  // Starts as the reader's Group numbers setting, so an export shows what the canvas shows.
  const readerNumbers = useGroupNumbers().numbered;
  const [numbered, setNumbered] = useState(readerNumbers);
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "needs-consent" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  useEffect(() => {
    alive.current = true;
    const before = document.activeElement;
    first.current?.focus();
    return () => {
      alive.current = false;
      request.current++;
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  useEffect(() => {
    request.current++;
    setConsent(false);
    setStatus("idle");
    setMessage("");
  }, [activeEmphasisId, annotation]);
  // Changing an export choice invalidates an earlier response and explicit consent.
  function edit(change: () => void): void {
    request.current++;
    change();
    setConsent(false);
    setStatus("idle");
    setMessage("");
  }
  async function download(): Promise<void> {
    const mine = ++request.current;
    setStatus("loading");
    setMessage("");
    try {
      const raw = await callOperation("export_diagram", {
        viewId,
        format,
        mode,
        theme,
        scale: 1,
        expectedRevision: revision,
        activeEmphasisId: mode === "presentation" ? activeEmphasisId : null,
        annotation: mode === "presentation" && caption ? annotation : "",
        diagramKey: mode === "presentation" && key,
        accessible: mode === "presentation" && activeEmphasisId !== null && numbered,
        allowLastGood: consent,
      });
      if (!alive.current || mine !== request.current) return;
      const artifact = readArtifact(raw, format, revision);
      saveArtifact(artifact, `${viewId}-${mode}-${theme}${artifact.lastGood ? "-last-good" : ""}.${format}`);
      setStatus("done");
      setMessage(
        `${format.toUpperCase()} downloaded · ${artifact.width} × ${artifact.height}${artifact.lastGood ? " · last-good drawing" : ""}`,
      );
    } catch (error) {
      if (!alive.current || mine !== request.current) return;
      if (error instanceof PageOperationError && error.code === "export_last_good_requires_opt_in") {
        setStatus("needs-consent");
        setMessage("The current source does not compile. You can explicitly export the last-good drawing below.");
      } else {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Export failed. Try again.");
      }
    }
  }
  return (
    <section
      role="region"
      aria-labelledby="archer-export-heading"
      className="archer-artifact-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="archer-artifact-header">
        <div>
          <h2 id="archer-export-heading">Export Diagram</h2>
          <p>{viewId}</p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <p>Exports the full drawing. Selection, hover, viewport and animation are not included.</p>
      <div className="archer-export-choices">
        <label>
          File type
          <select
            ref={first}
            value={format}
            onChange={(event) => edit(() => setFormat(event.target.value as "svg" | "png"))}
          >
            <option value="svg">SVG · scalable</option>
            <option value="png">PNG · image</option>
          </select>
        </label>
        <label>
          Content
          <select
            value={mode}
            onChange={(event) => edit(() => setMode(event.target.value as "diagram" | "presentation"))}
          >
            <option value="diagram">Diagram only</option>
            <option value="presentation">Presentation</option>
          </select>
        </label>
        <label>
          Export theme
          <select value={theme} onChange={(event) => edit(() => setTheme(event.target.value as "light" | "dark"))}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </div>
      {mode === "presentation" ? (
        <>
          <p>
            Includes the visible agent highlights as a static mark{activeEmphasisId === null ? " (none selected)" : ""}.
          </p>
          <label className="archer-export-option">
            <input
              type="checkbox"
              checked={caption}
              onChange={(event) => edit(() => setCaption(event.target.checked))}
            />
            Include caption
          </label>
          <label className="archer-export-option">
            <input type="checkbox" checked={key} onChange={(event) => edit(() => setKey(event.target.checked))} />
            Include diagram key
          </label>
          {activeEmphasisId === null ? null : (
            <label className="archer-export-option">
              <input
                type="checkbox"
                checked={numbered}
                onChange={(event) => edit(() => setNumbered(event.target.checked))}
              />
              Number the highlight groups
            </label>
          )}
        </>
      ) : null}
      {status === "needs-consent" ? (
        <label className="archer-export-option">
          <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />I choose the
          last-good drawing
        </label>
      ) : null}
      {message ? <p role={status === "error" || status === "needs-consent" ? "alert" : "status"}>{message}</p> : null}
      <button
        type="button"
        className="archer-artifact-primary"
        disabled={status === "loading" || (status === "needs-consent" && !consent)}
        onClick={() => {
          void download();
        }}
      >
        {status === "loading" ? "Preparing export…" : "Download"}
      </button>
    </section>
  );
}
